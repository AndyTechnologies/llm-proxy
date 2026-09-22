<script lang="ts">
  import type { IconName } from "../../lib/navigation.js";

  interface IconPart {
    d: string;
    fill?: boolean;
  }

  /** Single-accent, hand-authored geometry (24px viewBox, stroke style). */
  const ICON_GEOMETRY: Record<IconName, readonly IconPart[]> = {
    overview: [
      { d: "M4 11.5 12 4.5l8 7" },
      { d: "M6.5 10V19h11V10" },
    ],
    workflows: [
      { d: "M6.5 5a2.5 2.5 0 1 1 5 0 2.5 2.5 0 1 1-5 0z" },
      { d: "M12.5 5a2.5 2.5 0 1 1 5 0 2.5 2.5 0 1 1-5 0z" },
      { d: "M9 7.5 10.5 14.5" },
      { d: "M15 7.5l1.5 7" },
      { d: "M9.5 17a2.5 2.5 0 1 1 5 0 2.5 2.5 0 1 1-5 0z" },
    ],
    models: [
      { d: "M12 3l8 4.5v9L12 21l-8-4.5v-9z" },
      { d: "M4 7.5l8 4.5 8-4.5" },
      { d: "M12 12v9" },
    ],
    catalog: [
      { d: "M5 5h3a3 3 0 0 1 3 3v11a2 2 0 0 0-2-2H5z" },
      { d: "M19 5h-3a3 3 0 0 0-3 3v11a2 2 0 0 1 2-2h4z" },
    ],
    downloads: [
      { d: "M12 4v10" },
      { d: "M8.5 10.5 12 14l3.5-3.5" },
      { d: "M5 16.5v2h14v-2" },
    ],
    providers: [
      { d: "M9 2v6" },
      { d: "M15 2v6" },
      { d: "M6 8h12v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4z" },
      { d: "M12 17v5" },
    ],
    executions: [{ d: "M22 12h-4l-3-9L9 21l-3-9H2" }],
    api: [
      { d: "M5 6l5 5-5 5" },
      { d: "M12 17h7" },
    ],
    runtime: [
      { d: "M7 7h10v10H7z" },
      { d: "M12 2v3" },
      { d: "M12 19v3" },
      { d: "M2 12h3" },
      { d: "M19 12h3" },
      { d: "M5.5 5.5l2 2" },
      { d: "M16.5 16.5l2 2" },
      { d: "M18.5 5.5l-2 2" },
      { d: "M7.5 16.5l-2 2" },
    ],
    settings: [
      { d: "M4 7h16" },
      { d: "M4 12h16" },
      { d: "M4 17h16" },
      { d: "M4.5 7a2.5 2.5 0 1 1 5 0 2.5 2.5 0 1 1-5 0z" },
      { d: "M13.5 12a2.5 2.5 0 1 1 5 0 2.5 2.5 0 1 1-5 0z" },
      { d: "M7.5 17a2.5 2.5 0 1 1 5 0 2.5 2.5 0 1 1-5 0z" },
    ],
    about: [
      { d: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 1 1 0-17z" },
      { d: "M12 11v5.5" },
      { d: "M12 7.75h.01" },
    ],
    search: [
      { d: "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 1 1 0-13z" },
      { d: "M15.6 15.6l5.2 5.2" },
    ],
    github: [
      {
        d: "M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.75 2.69 1.25 3.35.95.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.17 1.18a11.1 11.1 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.11 3.06.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.78 1.05.78 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.21.67.8.56A10.52 10.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z",
        fill: true,
      },
    ],
    menu: [
      { d: "M4 7h16" },
      { d: "M4 12h16" },
      { d: "M4 17h16" },
    ],
    close: [
      { d: "M6 6l12 12" },
      { d: "M18 6L6 18" },
    ],
    back: [
      { d: "M19 12H5" },
      { d: "M11 6l-6 6 6 6" },
    ],
    chevron: [{ d: "M9 6l6 6-6 6" }],
    plus: [
      { d: "M12 5v14" },
      { d: "M5 12h14" },
    ],
    play: [{ d: "M8 5.5v13l11-6.5z" }],
    check: [{ d: "M5 12.5l4.5 4.5L19 7.5" }],
  };

  let {
    name,
    size = 16,
    strokeWidth = 1.75,
    label,
  }: {
    name: IconName;
    size?: number;
    strokeWidth?: number;
    label?: string;
  } = $props();
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden={label === undefined ? "true" : undefined}
  role={label === undefined ? undefined : "img"}
  aria-label={label}
>
  {#each ICON_GEOMETRY[name] as part, i (i)}
    <path
      d={part.d}
      fill={part.fill === true ? "currentColor" : "none"}
      stroke={part.fill === true ? "none" : "currentColor"}
    />
  {/each}
</svg>

<style>
  .icon {
    flex-shrink: 0;
    display: inline-block;
    vertical-align: middle;
  }
</style>