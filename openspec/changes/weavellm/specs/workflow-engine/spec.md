# Workflow Engine Specification

## Purpose

Executes the DAGs defined by the workflow editor: ordered execution, node taxonomy parity, composition techniques (e.g., MoA), conditional routing, and exposure of chains as virtual models.

## Requirements

### Requirement: DAG execution

The engine MUST execute workflows in topological order with parallel fan-out along independent branches, preserving the existing runChain orchestration seam.

#### Scenario: Linear chain executes in order

- GIVEN a chain A→B→C
- WHEN the workflow runs
- THEN steps execute A, then B, then C, each consuming the prior output

#### Scenario: Parallel branches join

- GIVEN two independent branches from a shared input
- WHEN the workflow runs
- THEN both branches execute and their outputs reach the join node

### Requirement: Node taxonomy parity

The engine MUST implement every node type the editor exposes (10+ types: llm.call, generate, refine, passthrough, rag_local, data.code, memory, embeddings, router, output).

#### Scenario: Taxonomy parity

- GIVEN the editor palette with 10+ node types
- WHEN the engine receives any palette workflow
- THEN every node type executes without an unknown-node error

### Requirement: Virtual model exposure

Every named chain SHALL be exposed as a virtual model `gateway/<chain-name>` for /v1/* clients, and selectable via the `X-Chain-ID` header.

#### Scenario: Chat by virtual model name

- GIVEN a chain `summarizer`
- WHEN a request targets `gateway/summarizer`
- THEN the chain executes and the response is OpenAI-shaped

#### Scenario: Header-based selection

- GIVEN multiple chains
- WHEN a request carries `X-Chain-ID: debate`
- THEN the `debate` chain executes

### Requirement: Composition techniques

The engine SHALL support techniques including mixture-of-agents (MoA) 3+1: three drafting nodes fanning into one synthesis node.

#### Scenario: MoA 3+1 synthesis

- GIVEN a MoA workflow with 3 drafting nodes and 1 synthesis node
- WHEN the workflow runs
- THEN the 3 drafts are produced and the synthesis node consumes all of them

### Requirement: Conditional routing

The engine SHALL route on `on_429` and `tool_calls_route` conditions, including cross-provider fallback when configured.

#### Scenario: 429 fallback

- GIVEN a node with `on_429` fallback to a second provider
- WHEN the primary returns 429
- THEN the secondary is invoked and its output is returned

#### Scenario: Tool-call routing

- GIVEN a tool-capable node with downstream branches
- WHEN the response contains tool_calls
- THEN execution routes to the tool branch