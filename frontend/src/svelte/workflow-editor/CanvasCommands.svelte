<script lang="ts">
  import { tick } from "svelte";
  import { useSvelteFlow } from "@xyflow/svelte";
  import type { CanvasApi, FlowPosition } from "../../lib/workflow-flow.js";

  /**
   * Child seam (U05) rendered INSIDE <SvelteFlow>: `useSvelteFlow()` only
   * works inside the provider context, so this component is the only place
   * that can touch the real instance. It hands the island the two
   * capabilities it needs (`fitView`, `screenToFlowPosition`) exactly once
   * via `onReady`, and re-fits whenever the parent bumps `queued`
   * (workflow load, initialGraph seed).
   */

  let {
    queued,
    onReady,
  }: {
    /** Bump to request a viewport fit (padding 15%). 0 = no pending fit. */
    queued: number;
    /** Called once, as soon as the instance is available. */
    onReady: (api: CanvasApi) => void;
  } = $props();

  const api = useSvelteFlow();
  let handedOff = false;

  $effect(() => {
    if (handedOff) return;
    handedOff = true;
    onReady({
      fitView: (options) => {
        void api.fitView({ padding: options?.padding ?? 0.15 }).catch(() => undefined);
      },
      screenToFlowPosition: (position: FlowPosition, snapToGrid = false) =>
        api.screenToFlowPosition(position, { snapToGrid }),
    });
  });

  $effect(() => {
    if (queued === 0) return;
    void tick().then(() => api.fitView({ padding: 0.15 }).catch(() => undefined));
  });
</script>