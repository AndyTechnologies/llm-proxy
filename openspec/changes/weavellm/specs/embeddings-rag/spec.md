# Embeddings & RAG Specification

## Purpose

Local embeddings generation, persistent vector storage, conversation memory, and a `rag_local` node that retrieves context before generation.

## Requirements

### Requirement: Local embeddings

The system SHALL generate embeddings via a local llama.cpp embeddings model and expose `/v1/embeddings` in OpenAI shape.

#### Scenario: Embeddings produced

- GIVEN a local embeddings model loaded
- WHEN a text is embedded
- THEN a fixed-dimension vector is returned in OpenAI shape

### Requirement: Persistent vector store

The system SHALL store document chunks with their vectors in SQLite and query them by similarity (top-k).

#### Scenario: Store and query

- GIVEN documents added to the store
- WHEN a query is embedded and matched
- THEN the top-k most similar chunks are returned ranked by score

#### Scenario: Empty store

- GIVEN no documents added
- WHEN a query runs
- THEN an empty result set is returned, not an error

### Requirement: Conversation memory

The system SHALL provide a `memory` node that retains prior turns per conversation and injects them as context in later steps.

#### Scenario: Memory injected

- GIVEN earlier turns recorded for a conversation
- WHEN a later workflow node runs
- THEN the retained turns are injected into its context

### Requirement: rag_local node

The `rag_local` node SHALL embed the query, retrieve top-k chunks, build a grounded prompt, and generate the answer with the configured model.

#### Scenario: RAG round-trip

- GIVEN a corpus with relevant documents
- WHEN the rag_local node runs
- THEN the answer is generated from retrieved chunks with source metadata in the output

#### Scenario: No relevant corpus

- GIVEN no chunks matching the query
- WHEN the rag_local node runs
- THEN generation proceeds with an explicit no-context notice, not a failure