/*
 * WeaveLLM self-extracting stub — the first bytes of dist/weavellm.
 *
 * On-disk artifact layout (written by scripts/build-binary.ts):
 *
 *   [ELF stub — this program]
 *   [payload: tar.gz of the Electrobun dev bundle]  WEAVELLM_TRAILER_SIZE bytes
 *   [trailer — WEAVELLM_TRAILER_LEN bytes at EOF, layout in
 *    selfextract-trailer.h, GENERATED from scripts/selfextract-layout.ts by
 *    scripts/build-binary.ts. The header is the single source of truth; do
 *    not hand-edit this file's byte offsets.]
 *
 * Runtime behavior (Linux, host-only matrix — see openspec
 * desktop-app-shell):
 *
 *   1. Resolve its own path via /proc/self/exe.
 *   2. Read the trailer at EOF (magic + format version + uint64 LE payload
 *      size + sha256 hex of the payload).
 *   3. Extraction dir = $XDG_CACHE_HOME/weavellm/<payload sha256> (fallback
 *      ~/.cache/weavellm/<payload sha256>). Marker file ".complete" means the
 *      bundle is already extracted — skip. A ".lock" flock serializes racing
 *      first runs.
 *   4. If not extracted: write the payload to <.payload.tar.gz> inside the
 *      extraction dir and shell out to `tar -xzf` (the supported Ubuntu
 *      24.04+ targets ship tar); on failure the whole extraction dir is
 *      removed. The cache dir is fixed and owned by weavellm, so feeding the
 *      self-contained payload to tar is inside our trust boundary.
 *   5. Set WEBKIT_DISABLE_DMABUF_RENDERER=1 unless the var is already present
 *      in environ (WebKitGTK on Xwayland + NVIDIA renders the window black
 *      otherwise; an explicit override, even an empty one, wins).
 *   6. exec <extraction dir>/bin/launcher, passing through argv and env. The
 *      launcher resolves Resources/ relative to its own bin dir, so it runs
 *      standalone; exec replaces this process, so the launcher's exit code
 *      becomes the exit code of dist/weavellm.
 *
 * The artifact stays far under the 100 MB gate: this stub is ~30 KB and the
 * compressed bundle is ~44 MB. A Bun-compiled stub would exceed the gate.
 */

#define _FILE_OFFSET_BITS 64
#define _GNU_SOURCE

#include "selfextract-trailer.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define WEAVELLM_MARKER_FILE ".complete"
#define WEAVELLM_LOCK_FILE ".lock"
#define WEAVELLM_PAYLOAD_TMP ".payload.tar.gz"
#define WEAVELLM_CACHE_SUBDIR "weavellm"
#define WEAVELLM_LAUNCHER_REL "bin/launcher"
#define WEAVELLM_RENDER_ENV "WEBKIT_DISABLE_DMABUF_RENDERER="

static void die(const char *msg) {
  fprintf(stderr, "weavellm: %s\n", msg);
  exit(1);
}

static void die_errno(const char *msg) {
  fprintf(stderr, "weavellm: %s: %s\n", msg, strerror(errno));
  exit(1);
}

/* Recursively create a directory (mkdir -p). */
static void mkdir_p(const char *path) {
  char tmp[PATH_MAX];
  size_t len = strlen(path);
  if (len == 0 || len >= sizeof(tmp)) die("cache path too long");
  memcpy(tmp, path, len + 1);
  for (char *p = tmp + 1; *p; p++) {
    if (*p == '/') {
      *p = '\0';
      if (mkdir(tmp, 0755) != 0 && errno != EEXIST) die_errno("mkdir");
      *p = '/';
    }
  }
  if (mkdir(tmp, 0755) != 0 && errno != EEXIST) die_errno("mkdir");
}

/* The path of the running executable (the ELF with the payload appended). */
static void self_path(char *out, size_t cap) {
  ssize_t n = readlink("/proc/self/exe", out, cap - 1);
  if (n < 0) die_errno("cannot resolve /proc/self/exe");
  out[n] = '\0';
}

/* Read and validate the appended trailer. Returns payload size; hash hex
 * copied into hash (WEAVELLM_TRAILER_HASH_LEN hex chars, NUL-terminated). */
static uint64_t read_trailer(FILE *self, uint64_t file_size, char *hash) {
  uint8_t buf[WEAVELLM_TRAILER_LEN];
  if (file_size < (uint64_t)WEAVELLM_TRAILER_LEN) die("file too small: missing trailer");
  if (fseeko(self, -(off_t)WEAVELLM_TRAILER_LEN, SEEK_END) != 0) die_errno("seek");
  if (fread(buf, 1, sizeof(buf), self) != sizeof(buf)) die("cannot read trailer");

  if (memcmp(buf, WEAVELLM_TRAILER_MAGIC, WEAVELLM_TRAILER_MAGIC_LEN) != 0) {
    die("bad trailer magic — not a portable weavellm binary, or corrupted");
  }
  if (buf[WEAVELLM_TRAILER_MAGIC_LEN] != WEAVELLM_TRAILER_VERSION) {
    die("unsupported trailer format version — rebuild with a matching build:binary");
  }

  uint64_t size = 0;
  const uint8_t *size_bytes = buf + WEAVELLM_TRAILER_MAGIC_LEN + WEAVELLM_TRAILER_VERSION_LEN;
  for (int i = 0; i < WEAVELLM_TRAILER_SIZE_LEN; i++) {
    size |= (uint64_t)size_bytes[i] << (8 * i);
  }
  if (size == 0 || size > file_size - (uint64_t)WEAVELLM_TRAILER_LEN) {
    die("invalid payload size in trailer");
  }

  const uint8_t *hash_bytes = size_bytes + WEAVELLM_TRAILER_SIZE_LEN;
  memcpy(hash, hash_bytes, WEAVELLM_TRAILER_HASH_LEN);
  hash[WEAVELLM_TRAILER_HASH_LEN] = '\0';
  return size;
}

/* $XDG_CACHE_HOME when set and non-empty, else ~/.cache (matches
 * scripts/selfextract-layout.ts resolveCacheBase). */
static void cache_base(char *out, size_t cap) {
  const char *xdg = getenv("XDG_CACHE_HOME");
  if (xdg != NULL && xdg[0] != '\0') {
    snprintf(out, cap, "%s", xdg);
    return;
  }
  const char *home = getenv("HOME");
  if (home == NULL || home[0] == '\0') {
    die("neither XDG_CACHE_HOME nor HOME is set");
  }
  snprintf(out, cap, "%s/.cache", home);
}

static int file_exists(const char *path) {
  struct stat st;
  return stat(path, &st) == 0;
}

/* Copy the payload bytes from self into dir/<WEAVELLM_PAYLOAD_TMP>. */
static void write_payload(FILE *self, uint64_t payload_size, uint64_t payload_offset,
                          const char *tmp_path) {
  if (fseeko(self, (off_t)payload_offset, SEEK_SET) != 0) die_errno("seek to payload");
  FILE *out = fopen(tmp_path, "wb");
  if (out == NULL) die_errno("cannot create payload temp file");
  uint8_t chunk[1 << 16];
  uint64_t remaining = payload_size;
  while (remaining > 0) {
    size_t want = remaining > sizeof(chunk) ? sizeof(chunk) : (size_t)remaining;
    size_t got = fread(chunk, 1, want, self);
    if (got == 0) {
      fclose(out);
      die("short read while copying the payload");
    }
    if (fwrite(chunk, 1, got, out) != got) {
      fclose(out);
      die_errno("cannot write payload temp file");
    }
    remaining -= got;
  }
  if (fclose(out) != 0) die_errno("cannot finish payload temp file");
}

static int run_tool(char *const argv[]) {
  pid_t pid = fork();
  if (pid < 0) die_errno("fork");
  if (pid == 0) {
    execvp(argv[0], argv);
    _exit(127);
  }
  int status = 0;
  if (waitpid(pid, &status, 0) != pid) die_errno("waitpid");
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

static void remove_tree(const char *dir) {
  char *const rm_argv[] = {"rm", "-rf", (char *)dir, NULL};
  (void)run_tool(rm_argv);
}

/* Extract the payload into dir (already mkdir'ed) under an exclusive lock.
 * Marker writes happen only after a fully successful extraction. */
static void extract_bundle(FILE *self, uint64_t payload_size, uint64_t payload_offset,
                           const char *dir) {
  char lock_path[PATH_MAX];
  snprintf(lock_path, sizeof(lock_path), "%s/%s", dir, WEAVELLM_LOCK_FILE);
  int lock_fd = open(lock_path, O_CREAT | O_RDWR, 0600);
  if (lock_fd < 0) die_errno("cannot open extraction lock");
  if (flock(lock_fd, LOCK_EX) != 0) die_errno("cannot lock extraction");

  char marker_path[PATH_MAX];
  snprintf(marker_path, sizeof(marker_path), "%s/%s", dir, WEAVELLM_MARKER_FILE);
  if (file_exists(marker_path)) {
    flock(lock_fd, LOCK_UN);
    close(lock_fd);
    return;
  }

  char tmp_path[PATH_MAX];
  snprintf(tmp_path, sizeof(tmp_path), "%s/%s", dir, WEAVELLM_PAYLOAD_TMP);

  write_payload(self, payload_size, payload_offset, tmp_path);

  char *const tar_argv[] = {"tar", "-xzf", tmp_path, "-C", (char *)dir, NULL};
  int code = run_tool(tar_argv);
  unlink(tmp_path);
  if (code != 0) {
    remove_tree(dir);
    fprintf(stderr, "weavellm: extraction failed (tar exit %d)\n", code);
    exit(1);
  }

  FILE *marker = fopen(marker_path, "w");
  if (marker == NULL) {
    remove_tree(dir);
    die_errno("cannot write extraction marker");
  }
  fputs("complete\n", marker);
  fclose(marker);

  flock(lock_fd, LOCK_UN);
  close(lock_fd);
}

/* WebKitGTK on Xwayland + NVIDIA cannot create GBM/GLX buffers, rendering
 * the webview black; disable the DMABUF renderer unless the user already set
 * the variable (an explicit value, even an empty one, wins). */
static void ensure_render_env(void) {
  const char *needle = WEAVELLM_RENDER_ENV;
  for (char **e = environ; *e != NULL; e++) {
    if (strncmp(*e, needle, strlen(needle)) == 0) return;
  }
  setenv("WEBKIT_DISABLE_DMABUF_RENDERER", "1", 0);
}

int main(int argc, char **argv) {
  char self[PATH_MAX];
  self_path(self, sizeof(self));

  FILE *f = fopen(self, "rb");
  if (f == NULL) die_errno("cannot open own binary");

  if (fseeko(f, 0, SEEK_END) != 0) die_errno("seek end");
  off_t end = ftello(f);
  if (end < 0) die_errno("tell");
  uint64_t file_size = (uint64_t)end;

  char hash[WEAVELLM_TRAILER_HASH_LEN + 1];
  uint64_t payload_size = read_trailer(f, file_size, hash);
  uint64_t payload_offset = file_size - (uint64_t)WEAVELLM_TRAILER_LEN - payload_size;

  char base[PATH_MAX];
  cache_base(base, sizeof(base));

  char dir[PATH_MAX];
  if (snprintf(dir, sizeof(dir), "%s/%s/%s", base, WEAVELLM_CACHE_SUBDIR, hash) >=
      (int)sizeof(dir)) {
    die("extraction cache path too long");
  }

  if (!file_exists(dir)) {
    mkdir_p(dir);
    fprintf(stderr, "weavellm: extracting bundle to %s (first run)\n", dir);
  }
  extract_bundle(f, payload_size, payload_offset, dir);
  fclose(f);

  ensure_render_env();

  char launcher[PATH_MAX];
  snprintf(launcher, sizeof(launcher), "%s/%s", dir, WEAVELLM_LAUNCHER_REL);
  if (access(launcher, X_OK) != 0) die("extracted launcher not found — cache corrupted");

  /* exec replaces this process: the launcher's exit code propagates. argv[0]
   * is the launcher path because the Electrobun launcher resolves Resources
   * relative to dirname(argv[0]). */
  char **nargv = calloc((size_t)argc + 1, sizeof(char *));
  if (nargv == NULL) die("out of memory");
  nargv[0] = launcher;
  for (int i = 1; i < argc; i++) nargv[i] = argv[i];

  execv(launcher, nargv);
  fprintf(stderr, "weavellm: exec launcher failed: %s\n", strerror(errno));
  free(nargv);
  return 127;
}