<script lang="ts">
  import { nodeSummaryLines, type FlowNodeData } from "../../../lib/workflow-flow.js";
  import { nodeTypeDef } from "../../../lib/workflow-nodes.js";
  import NodeShell from "./NodeShell.svelte";

  /**
   * Custom canvas node for the start/end group — the graph boundary nodes.
   * Handles follow the engine semantics via the taxonomy helpers: `start`
   * has only a source handle, `end` only a target handle.
   */

  let { id, data, selected }: { id: string; data: FlowNodeData; selected: boolean } = $props();

  const entry = $derived(nodeTypeDef(data.wNodeType));
  const lines = $derived(nodeSummaryLines(data));
</script>

<NodeShell {entry} nodeId={id} {selected} {lines} />