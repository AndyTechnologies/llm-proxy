<script lang="ts">
  import { nodeSummaryLines, type FlowNodeData } from "../../../lib/workflow-flow.js";
  import { nodeTypeDef } from "../../../lib/workflow-nodes.js";
  import NodeShell from "./NodeShell.svelte";

  /**
   * Custom canvas node for the output group — an explicit graph output. The
   * type carries no editable fields yet, so the card shows only its
   * description.
   */

  let { id, data, selected }: { id: string; data: FlowNodeData; selected: boolean } = $props();

  const entry = $derived(nodeTypeDef(data.wNodeType));
  const lines = $derived(nodeSummaryLines(data));
</script>

<NodeShell {entry} nodeId={id} {selected} {lines} />