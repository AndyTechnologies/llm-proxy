# Workflow Editor Specification

## Purpose

Visual editor for composing model workflows as DAGs on a canvas (@xyflow/svelte 1.6.6), with YAML interchange and validation. The editor and the workflow-engine SHALL share one node taxonomy so anything drawn can execute.

## Requirements

### Requirement: DAG canvas editing

The system SHALL provide a canvas where the user creates, moves, and connects nodes, forming a directed acyclic graph.

#### Scenario: Node placement and connection

- GIVEN an empty canvas
- WHEN the user drops two nodes and connects them
- THEN the edge is drawn and the graph structure is recorded

#### Scenario: Cycle attempt rejected

- GIVEN an edge that would close a cycle
- WHEN the user connects the final edge
- THEN the connection is rejected with an inline cycle error

### Requirement: Node palette

The editor MUST expose at least 10 node types covering the full taxonomy: llm.call, generate, refine, passthrough, rag_local, data.code, memory, embeddings, router, output, and technique composites.

#### Scenario: Palette completeness

- GIVEN the editor open
- WHEN the palette is inspected
- THEN at least 10 node types are listed, each draggable onto the canvas

### Requirement: YAML import and export

The system SHALL export workflows to YAML and import from YAML such that serialization preserves workflow semantics.

#### Scenario: Export round-trip

- GIVEN a configured workflow on the canvas
- WHEN the user exports
- THEN a YAML document is produced that re-imports to the same graph

#### Scenario: Invalid YAML rejected

- GIVEN a YAML file with a malformed node definition
- WHEN the user imports it
- THEN import fails with errors naming the offending node

### Requirement: Workflow validation

The system SHALL validate a graph before save/execution: acyclic, connected, required fields present, and valid node configuration.

#### Scenario: Missing required field

- GIVEN a llm.call node without a model
- WHEN validation runs
- THEN an inline error marks the node and saving is blocked

#### Scenario: Valid workflow passes

- GIVEN a complete acyclic workflow
- WHEN validation runs
- THEN validation passes and the workflow is ready to execute