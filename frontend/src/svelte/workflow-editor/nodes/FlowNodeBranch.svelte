<script lang="ts">
  import { nodeSummaryLines, type FlowNodeData } from "../../../lib/workflow-flow.js";
  import { nodeTypeDef } from "../../../lib/workflow-nodes.js";
  import NodeShell from "./NodeShell.svelte";

  /**
   * Custom canvas node for the branch group — condition, loop, fan, join and
   * router. Cards summarize the routed expression (condition/router), the
   * iteration bound (loop) or the parallel fan-out flag.
   */

  let { id, data, selected }: { id: string; data: FlowNodeData; selected: boolean } = $props();

  const entry = $derived(nodeTypeDef(data.wNodeType));
  const lines = $derived(nodeSummaryLines(data));
</script>

<NodeShell {entry} nodeId={id} {selected} {lines} />