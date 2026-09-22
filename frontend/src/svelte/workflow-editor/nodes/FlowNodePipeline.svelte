<script lang="ts">
  import { nodeSummaryLines, type FlowNodeData } from "../../../lib/workflow-flow.js";
  import { nodeTypeDef } from "../../../lib/workflow-nodes.js";
  import NodeShell from "./NodeShell.svelte";

  /**
   * Custom canvas node for the pipeline group — composition of another stored
   * workflow. The card shows the invoked pipeline name and the count of input
   * parameters when the composition carries any.
   */

  let { id, data, selected }: { id: string; data: FlowNodeData; selected: boolean } = $props();

  const entry = $derived(nodeTypeDef(data.wNodeType));
  const lines = $derived(nodeSummaryLines(data));
</script>

<NodeShell {entry} nodeId={id} {selected} {lines} />