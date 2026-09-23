<script lang="ts">
  import { nodeSummaryLines, type FlowNodeData } from "../../../lib/workflow-flow.js";
  import { nodeTypeDef } from "../../../lib/workflow-nodes.js";
  import NodeShell from "./NodeShell.svelte";

  /**
   * Custom canvas node for the llm_call group. Primary fields shown on the
   * card: model (flagged "unset" when missing — the engine requires it),
   * mode and provider override.
   */

  let { id, data, selected }: { id: string; data: FlowNodeData; selected: boolean } = $props();

  const entry = $derived(nodeTypeDef(data.wNodeType));
  const lines = $derived(nodeSummaryLines(data));
</script>

<NodeShell {entry} nodeId={id} {selected} {lines} />