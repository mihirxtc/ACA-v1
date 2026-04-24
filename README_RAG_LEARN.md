# Understanding RAG — A Learning Guide for the Viva

This guide is written for you, Mihir. You built this RAG system with AI
assistance and now need to own every decision well enough to defend it out
loud. Read each section, then read it again with the actual source file open
beside you. The goal is not to memorise — it is to build intuition deep
enough that any follow-up question the examiner throws at you lands somewhere
familiar.

---

## What Problem Does RAG Solve?

Before RAG was added, the assistant had two sources of knowledge: its training
data (everything the language model learned during pre-training, frozen at a
cutoff date) and live AWS scan results injected into each prompt at query time.
That combination was useful for "scan this account and tell me what's wrong,"
but it fell apart the moment a user asked a follow-up question like "what
should I actually do about my public S3 bucket?"

Without RAG the LLM answered that from training data — generic AWS knowledge
that it learned from blog posts and documentation written years ago. The advice
might say "enable Block Public Access" without quoting the specific CIS AWS
Foundations Benchmark control that mandates it, without showing the exact
Terraform resource blocks needed to fix it, and without any link back to a
document the user could look up. The answer was plausible but not
authoritative. You could not cite it in a compliance audit.

With RAG the system does something different before it answers. It searches
your own knowledge base — a database you pre-populated with curated AWS
security documentation — finds the three chunks of text most relevant to the
question, and injects them into the prompt before the user's question is even
shown to the model. The LLM then reads those retrieved chunks first, and when
it answers it is grounded in your documents. It can say "per CIS control
2.1.5, you must enable all four Block Public Access settings" and cite the
exact source. That specificity is what makes this tool useful in a real
security context rather than a general-purpose chatbot.

For a cloud security tool specifically this matters more than in most domains,
because security advice that cannot be traced to a standard is worthless. An
auditor does not want to hear "I enabled encryption because the AI said so."
They want a control number, a policy reference, a Terraform snippet they can
review. RAG makes those citations possible because the answer is anchored to
actual documents stored in your system.

---

## The Two Phases

Every RAG system does its work in two completely separate phases. The indexing
phase happens once when you load a document. The query phase happens on every
user request. It is important to keep these phases mentally separate because
they share some components (the same embedding model) but serve completely
different purposes.

### Indexing Phase

```
Raw document text
        |
        v
    chunk_text()          <-- splits into ~400 word pieces
        |
        v
    encoder.encode()      <-- converts each piece to a vector (384 numbers)
        |
        v
    collection.upsert()   <-- stores chunk text + vector on disk in ChromaDB
```

**What is happening at each arrow:**

`chunk_text()` in `knowledge_base.py` takes the full text of your document
and splits it into smaller pieces. Think of it like cutting a long document
into index cards. Each card is about 400 words, and consecutive cards
deliberately overlap by 50 words so that any sentence sitting at a boundary
between two cards appears in full on at least one of them. Without overlap,
a sentence that happens to fall exactly at the 400-word mark would be split
in half — the first half in one chunk, the second half in the next — and
neither chunk would carry the complete thought, making it harder to retrieve
correctly.

`encoder.encode()` takes each of those text chunks and runs it through the
`all-MiniLM-L6-v2` sentence-transformer model, producing a list of 384
floating-point numbers for each chunk. Those 384 numbers are not random —
they encode the *meaning* of the text in a form the database can compare.
Similar-meaning chunks produce similar sets of numbers. This is called an
embedding vector, and the model was specifically trained to produce these
meaning-preserving representations.

`collection.upsert()` writes everything to ChromaDB on disk. "Upsert" means
update-or-insert: if a chunk with that ID already exists it is overwritten,
if not it is created fresh. This is why you can run `seed_knowledge.py` twice
without creating duplicates. ChromaDB stores three things per chunk: the
original text (so the LLM can read it), the embedding vector (so similarity
search can find it), and any metadata you attached (so results can be
filtered by resource type, source document name, and so on).

### Query Phase

```
User's question
        |
        v
    encoder.encode()              <-- same model, same vector space
        |
        v
    collection.query()            <-- finds vectors closest to question vector
        |
        v
    RELEVANCE_THRESHOLD filter    <-- discards low-scoring chunks
        |
        v
    build_augmented_prompt()      <-- wraps chunks + question into one prompt
        |
        v
    LLM API call
        |
        v
    Grounded answer with sources
```

**What is happening at each arrow:**

`encoder.encode()` runs the user's question through the same `all-MiniLM-L6-v2`
model that was used during indexing. This is non-negotiable — you must use
the same model for both phases. If you indexed with one model and queried with
a different one, the resulting numbers would exist in completely different
coordinate systems, and the closest-vector search would return nonsense.

`collection.query()` takes the question's vector and asks ChromaDB to find
the stored chunk vectors that point in the most similar direction. ChromaDB
uses an algorithm called HNSW (Hierarchical Navigable Small World) to do this
efficiently even across thousands of chunks. It returns the top N candidates
along with how far apart each one was from the question vector. Closer means
more similar in meaning.

The **RELEVANCE_THRESHOLD filter** in `rag_service.py` throws away any
returned chunk whose relevance score is below 0.3. The relevance score is
computed as `1 - distance`, so a score of 0.3 means there is some topical
overlap but the chunk is not strongly aligned to the question. Anything below
0.3 is likely coincidental and would add noise to the prompt rather than
useful grounding.

`build_augmented_prompt()` takes the surviving chunks and assembles the final
prompt. It places the retrieved chunks *before* the question, labels each one
with its source document and relevance score, and adds a framing instruction
telling the model to treat the retrieved content as its primary reference.
When no chunks survive the threshold filter, it falls back to a plain expert
prompt without any retrieved context — the model still answers from training
knowledge, and the user gets a useful response rather than an error.

The **LLM API call** sends this assembled prompt to whichever LLM backend the
user has configured (Groq, Anthropic, or Ollama). The model reads the source
context first, then the question, and produces an answer that is grounded in
the retrieved documents.

---

## Key Concepts

### What Is an Embedding?

Think of every sentence as a point in a very large space. The space has 384
dimensions — which you cannot visualise, but the geometry still works like
any other space. Sentences with similar meaning end up close together in this
space. "Ensure S3 buckets block public access" and "prevent public read on
your S3 bucket" would land very close to each other. "How to configure an
IAM role" would land somewhere completely different. The embedding model —
`all-MiniLM-L6-v2` in this project — was trained on enormous amounts of text
specifically to learn these placements. It outputs a list of exactly 384
numbers for any piece of text you feed it, and those 384 numbers are the
coordinates of that text's point in meaning-space.

The reason we use the same model (`all-MiniLM-L6-v2`) for both indexing and
querying is that the model defines the coordinate system. Every embedding it
produces exists in the same 384-dimensional space, which means stored chunk
vectors and question vectors can be directly compared. If you used a different
model to encode the question, it would produce coordinates in a different
coordinate system — the numbers might look similar but they would be measuring
completely different dimensions of meaning, and the nearest-neighbour search
would be meaningless.

### What Is Chunking and Why Does It Matter?

The `all-MiniLM-L6-v2` model has a maximum input of roughly 256 to 512
word-piece tokens. If you tried to embed an entire document — say a 50-page
AWS security policy — the model would silently truncate it to its limit and
encode only the first portion, producing a vector that represents the
introduction of the document rather than its content. Worse, even if you
could embed the whole document, its vector would be a vague average of
everything in it, which makes retrieval imprecise: every query about any
topic in the document would retrieve it, and so would many queries that are
barely related.

Chunking solves this by breaking the document into focused pieces. In this
project, `chunk_text()` in `knowledge_base.py` uses a sliding window of 400
words with a 50-word overlap between consecutive chunks. The 400-word limit
sits comfortably within the model's capacity while being long enough to
carry a coherent idea. The 50-word overlap exists for a specific reason: if
you cut cleanly at every 400th word, a sentence sitting on the boundary would
be split — the first half in one chunk, the second half in the next — and
neither retrieval result would carry the full thought. With 50 words of
overlap, boundary content appears in both chunks, so no idea is lost.

### What Is Cosine Similarity?

Imagine two arrows both starting at the origin of a coordinate space. Cosine
similarity measures the angle between those two arrows, not the length of
either arrow. Two arrows pointing in exactly the same direction have a cosine
similarity of 1.0 — perfect agreement. Two arrows pointing in perpendicular
directions have a cosine similarity of 0.0 — no relationship. Two arrows
pointing in exactly opposite directions have a cosine similarity of -1.0 —
maximum disagreement.

The embedding model converts text into the direction of an arrow in
384-dimensional space. ChromaDB's job is to find all the arrows you stored
at indexing time that point in the most similar direction to the arrow
produced by the query question. The resulting `relevance_score` in this
codebase is computed as `1 - distance`, where ChromaDB reports cosine
distance rather than cosine similarity. For the normalised vectors produced
by sentence transformers, the scores in practice fall in the range 0.0 to
1.0, where 1.0 means identical meaning and 0.0 means completely unrelated.
The threshold of 0.3 in `rag_service.py` means: if a chunk scores below 0.3,
discard it — it is not relevant enough to be useful context for this
particular query.

### What Is an Augmented Prompt?

An augmented prompt is a regular LLM prompt that has been extended with
retrieved document context before the user's question. Here is the structure
that `build_augmented_prompt()` in `rag_service.py` produces:

```
You are an AWS cloud security expert assistant for the Agentic Cloud
Assistant system.

The following knowledge has been retrieved from the security knowledge base:

[Source 1: aws-s3-security | relevance: 0.82]
S3 Bucket Security Best Practices
Always enable S3 Block Public Access at the account level and per-bucket
level... CIS 2.1.5: Ensure S3 buckets are configured with Block Public Access.

---

[Source 2: terraform-security-patterns | relevance: 0.71]
resource "aws_s3_bucket_public_access_block" "block" {
  block_public_acls       = true
  ...
}

---

Using the retrieved knowledge above as your primary reference, answer
this question:
What should I do about my public S3 bucket?
```

The context comes *before* the question for a reason: language models read
from left to right (or token by token in sequence), and research has shown
they give more weight to context established early in the prompt. By placing
the retrieved documents first, you ensure the model has absorbed the factual
grounding before it encounters the question it needs to answer. If the context
came after the question, the model might produce an answer from training memory
before it fully processed the retrieved material.

The word "grounded" describes an answer that is anchored to specific source
documents rather than generated freely from training memory. A grounded answer
can say "per CIS control 2.1.5..." because the text of that control is
literally in the prompt. This reduces hallucination — the tendency of LLMs to
produce confident-sounding but fabricated information — because the model has
real text to quote from rather than reconstructing knowledge from imperfect
training memory.

### What Is ChromaDB?

ChromaDB is a vector database — a database designed specifically to store
embedding vectors and to search them efficiently by similarity. A regular SQL
database like PostgreSQL stores data in rows and columns and searches it using
equality or range comparisons: `WHERE resource_type = 's3'` or
`WHERE score > 0.5`. That kind of comparison cannot find the nearest vector
to a query vector in a 384-dimensional space — there is no SQL operator for
cosine similarity across thousands of rows without scanning every single one.

ChromaDB solves this with an indexing algorithm called HNSW (Hierarchical
Navigable Small World), which builds a graph structure over all stored vectors
such that nearest-neighbour queries run in roughly logarithmic time rather
than linear time. You can search millions of vectors in milliseconds.

This project uses ChromaDB running locally with `PersistentClient` writing
its data to the `chroma_db/` directory. The alternative would be a cloud
vector database like Pinecone or Weaviate. Cloud services require an API key,
charge per query, need a network connection, and introduce data-privacy
concerns when you are storing security findings. For a dissertation-scale
project that runs on a single machine, local ChromaDB has no running cost,
works offline, requires no external account, and provides exactly the same
semantic search capabilities. The tradeoff would only become relevant at
production scale — hundreds of thousands of documents, multi-user
concurrency, or geo-redundancy requirements that are well beyond this scope.

### What Is a Singleton?

A singleton is a design pattern where only one instance of an object is
created for the entire lifetime of the application, and every piece of code
that needs it receives a reference to that same object rather than creating
a new one.

Think of the embedding model as a very heavy book — about 90 megabytes on
disk — that you need to fetch from a warehouse every time you want to use
it. A singleton means you fetch it once and keep it on your desk. Without
a singleton, every incoming API request would go back to the warehouse: load
the model from disk, hold it in RAM for the duration of the request, then
let it be garbage-collected when the request finishes. The next request would
repeat the trip. Each load takes 10 to 15 seconds and uses a substantial
chunk of RAM.

In this codebase, the singleton is the module-level line at the bottom of
`knowledge_base.py`:

```python
knowledge_base = SecurityKnowledgeBase()
```

When Python imports `knowledge_base.py` for the first time it executes this
line and creates one `SecurityKnowledgeBase` instance, which opens the
ChromaDB connection. Every subsequent import of the module returns the same
already-constructed object — Python caches modules. The `encoder` property
inside `SecurityKnowledgeBase` uses its own lazy-loading singleton: the
`SentenceTransformer` model is not loaded in `__init__` but rather the first
time `self.encoder` is accessed. This means the heavy model load is deferred
until the first actual RAG request, so the backend starts up quickly even
though RAG is available.

---

## How RAG Connects to MCP Tool Use

MCP stands for Model Control Protocol — it is the convention used in this
project for registering tools the language model can call autonomously. Here
is a step-by-step walkthrough of what happens when a user asks: "What is the
safest way to configure an S3 bucket?"

**Step 1:** The agentic loop in `agent_service.py` calls the Anthropic API
with the user's message and the `TOOLS` list. That list is defined in
`terraform_service.py` as:

```python
TOOLS = [TERRAFORM_TOOL, RUN_PLAN_TOOL, SUMMARISE_PLAN_TOOL, RAG_TOOL_DEFINITION]
```

`RAG_TOOL_DEFINITION` is imported from `rag_service.py`. Every tool in this
list has a name and a natural-language description that the model reads at
inference time. The model looks at all four tool descriptions and decides
which one, if any, it should call in response to this particular message.

**Step 2:** The model reads the `RAG_TOOL_DEFINITION` description, which
says: *"Search the security knowledge base for AWS best practices, CIS
benchmark controls, Terraform security patterns... Use this when the user
asks about security recommendations..."* The question matches that trigger
description, so the model returns a `tool_use` block in its response:

```json
{
  "name": "query_security_knowledge_base",
  "input": {
    "query": "S3 bucket security configuration best practices",
    "resource_type": "s3"
  }
}
```

The model is not running Python code. It is emitting structured JSON that
describes what it wants your backend to do on its behalf.

**Step 3:** The `agent_service.py` loop detects a `stop_reason == "tool_use"`
from the API response, extracts the tool name and input from the block, and
calls `dispatch_tool(tool_name, tool_input)` from `terraform_service.py`.

**Step 4:** Inside `dispatch_tool()`, the elif chain matches
`"query_security_knowledge_base"` and routes to:

```python
elif tool_name == "query_security_knowledge_base":
    return handle_rag_tool_call(tool_input)
```

`handle_rag_tool_call()` in `rag_service.py` unpacks the query and optional
filters from `tool_input`, then calls `query_knowledge_base()`.

**Step 5:** `query_knowledge_base()` calls `knowledge_base.search()`, which
encodes the query text with the `all-MiniLM-L6-v2` model and queries
ChromaDB for the closest matching chunks. ChromaDB returns the three most
similar chunks from the pre-seeded documents — in this case, chunks from
`aws-s3-security` and `terraform-security-patterns`.

**Step 6:** The result dictionary — containing the retrieved context text,
the list of source document IDs, and how many chunks were used — is returned
from `dispatch_tool()` back to the agentic loop. The loop formats it as a
`tool_result` message and appends it to the conversation history, then
makes another call to the Anthropic API with the full updated conversation
including the tool result.

**Step 7:** The model now reads the retrieved S3 security documentation in
the `tool_result` and generates a response that cites specific CIS control
IDs, references the Terraform `aws_s3_bucket_public_access_block` resource,
and quotes exact configuration values — all grounded in your knowledge base
rather than generic training memory.

---

## Pre-seeded vs User-Uploaded Documents

The knowledge base is populated in two different ways, and it is worth
understanding the distinction between them.

Pre-seeded documents are loaded by running `seed_knowledge.py` once during
setup. The script contains a hardcoded `SEED_DOCUMENTS` list of five
authoritative documents covering S3, EC2, IAM, VPC, and Terraform security
patterns. These are the baseline: they represent stable best-practice content
that every installation of this assistant should have from day one, before any
user interacts with the system. Running the script is idempotent — you can
run `cd backend && python -m rag.seed_knowledge` as many times as you like
because `add_document()` uses ChromaDB's upsert operation, which overwrites
existing chunks with the same ID rather than creating duplicates.

User-uploaded documents arrive through the API endpoints added to `main.py`:
a file upload endpoint (`POST /rag/documents/upload`) that accepts PDFs and
plain-text files, and a text paste endpoint (`POST /rag/documents/text`) for
content entered directly. These allow the team to add their own internal
runbooks, architecture decision records, custom compliance policies, or any
other document they want the assistant to reason from. When the same `doc_id`
is uploaded twice, the exact same upsert behaviour applies — all existing
chunks for that document are replaced with the new version. This means
updating a document is as simple as re-uploading it with the same `doc_id`:
there is no delete-then-insert pattern needed, and no risk of leaving stale
chunks behind alongside the new ones.

---

## Viva Q&A — Practice These Out Loud

---

**Q: What is RAG and why did you add it to this project?**

RAG stands for Retrieval-Augmented Generation, and it is a technique that
supplements a language model's training knowledge with documents you retrieve
at query time. I added it because the assistant was already scanning live AWS
infrastructure and identifying security issues, but when users asked follow-up
questions like "how should I fix this?" the model's answers were generic — it
had no access to specific CIS Benchmark control numbers, exact Terraform
remediation patterns, or any organisation-specific documentation. With RAG,
the system searches a pre-populated knowledge base before answering, injects
the most relevant chunks into the prompt, and the model can now give precise,
citable advice grounded in real documents rather than vague training memory.

---

**Q: What is an embedding and how does the model produce one?**

An embedding is a fixed-length list of numbers that encodes the meaning of a
piece of text. I use the `all-MiniLM-L6-v2` sentence-transformer model, which
produces a vector of exactly 384 numbers for any text input. The model was
trained on large amounts of text to position semantically similar sentences
close together in this 384-dimensional space — think of it as each sentence
getting coordinates in meaning-space, where sentences about the same topic
land near each other even if they use different words. The reason this is
useful for search is that you can compare any two pieces of text by comparing
their coordinate vectors, and "close in meaning" maps directly to "close in
this numeric space."

---

**Q: Why did you choose ChromaDB instead of a cloud vector database?**

I chose ChromaDB because it runs entirely locally with zero external
dependencies. A cloud service like Pinecone would require an API key, charge
per query or per stored vector, and would mean sending security findings and
internal documentation to a third-party server — which is undesirable when
the whole point of this tool is to handle sensitive AWS infrastructure data.
ChromaDB persists its data to the local `chroma_db/` directory, works
completely offline, and has no ongoing cost. For dissertation scale — a handful
of documents and a single user — it provides exactly the same semantic search
quality as any cloud alternative. The tradeoff would only become relevant at
production scale requiring multi-user concurrency or geographic redundancy.

---

**Q: How does RAG connect to your agentic loop?**

The connection point is the `RAG_TOOL_DEFINITION` dictionary in `rag_service.py`,
which defines the tool's name, a natural-language description the model reads
to decide when to call it, and an input schema describing what parameters to
pass. This definition is added to the `TOOLS` list in `terraform_service.py`
alongside the Terraform tools, and that list is passed to every Anthropic API
call in the agentic loop. When the model decides the question warrants a
knowledge base search, it emits a `tool_use` block, the loop calls
`dispatch_tool()` in `terraform_service.py`, which routes to
`handle_rag_tool_call()` in `rag_service.py`, which runs the retrieval and
returns the results as a `tool_result` message that feeds into the next
conversation turn.

---

**Q: What is chunking and why is overlap important?**

Chunking is the process of splitting a document into smaller pieces before
embedding it, because the embedding model has a maximum input length and
cannot meaningfully encode an entire document as one vector. In `chunk_text()`
in `knowledge_base.py`, I use a sliding window of 400 words per chunk with a
50-word overlap between consecutive chunks. The overlap is important because
without it, a sentence or idea that happens to fall exactly on a boundary
between two chunks would be split in half — the first part in one chunk, the
second part in the next — and neither chunk would carry the complete thought,
making it harder to retrieve that content correctly. The 50-word overlap means
any boundary content appears in full in at least one of the surrounding chunks.

---

**Q: What happens if the knowledge base has no relevant results for a query?**

There are two levels of fallback. First, the `RELEVANCE_THRESHOLD` filter in
`query_knowledge_base()` discards any chunks that score below 0.3, so even
if ChromaDB returns results they may all be filtered out if none are truly
relevant. Second, `build_augmented_prompt()` handles the case where the
surviving chunk list is empty — rather than raising an error, it constructs a
plain expert-assistant prompt without any retrieved context section and appends
a note saying "no specific documentation was found in the knowledge base for
this query." The user still receives a useful answer drawn from the model's
general training knowledge, and the note signals that uploading relevant
documents would improve future responses on this topic.

---

**Q: If your supervisor asked you to add AWS Cost Optimisation content to the knowledge base, how would you do it?**

The most straightforward approach would be to add a new entry to the
`SEED_DOCUMENTS` list in `backend/rag/seed_knowledge.py`. I would write a new
dict with a `doc_id` of something like `"aws-cost-optimisation"`, a `metadata`
dict containing `"resource_type": "general"` and `"source": "aws-best-practices"`,
and a `text` field containing the actual cost optimisation guidance — covering
topics like right-sizing EC2 instances, S3 storage tiers, and Reserved Instances.
Once that entry is in the list, I would run `cd backend && python -m rag.seed_knowledge`
to ingest it into ChromaDB. Because `add_document()` uses upsert, this would not
affect any of the five existing documents. I could then verify the ingestion worked
by calling `GET /rag/documents` and checking that the new `doc_id` appears in the
list with a non-zero chunk count.

---

**Q: What are the limitations of your RAG implementation?**

The first limitation is that chunking is word-count-based rather than
token-aware — `chunk_text()` counts whitespace-separated words, but the
embedding model processes word-piece tokens, and a 400-word chunk containing
long technical identifiers or hyphenated terms could exceed the model's 256
to 512 token limit, causing the encoder to silently truncate the chunk before
producing its vector. The second limitation is that all five pre-seeded
documents are short enough to produce only a single chunk each, which means
a query for a specific control number retrieves the entire document rather
than a targeted paragraph — retrieval precision will improve as longer
documents are added. The third limitation is that `list_documents()` rebuilds
the document list on every `GET /rag/documents` call by scanning all chunk
metadata and grouping by `doc_id` in Python, which is acceptable now but
would become slow at thousands of chunks. A fourth concern is that
`delete_document()` similarly scans all chunk IDs in Python to find the ones
belonging to a given document, which is an O(n) operation that scales linearly
with total collection size.

---

**Q: What does the RELEVANCE_THRESHOLD of 0.3 mean in practice?**

A relevance score of 0.3 means there is some surface-level topical overlap
between the retrieved chunk and the question, but the alignment is weak — the
chunk mentions related concepts but is probably not directly answering what
was asked. Setting the threshold at 0.3 means anything weaker than this gets
discarded before it reaches the prompt. If the threshold were lowered to 0.1,
almost every query would retrieve chunks regardless of how loosely related
they are, and the prompt would fill up with off-topic content that actively
misleads the model. If the threshold were raised to 0.8, only extremely
closely matched chunks would survive — which sounds better but in practice
means most queries return no results at all, because natural language
variation means the exact wording of a question rarely scores above 0.8
against the wording of a stored document. The value of 0.3 was chosen as a
practical balance: it filters out noise while still retrieving usefully
related content even when the user phrases their question differently from
how the document was written.

---

**Q: You said the model decides autonomously to search the knowledge base. How does that actually happen technically?**

The mechanism is the tool definition registration. `RAG_TOOL_DEFINITION` in
`rag_service.py` is a dictionary with three fields: `name` set to
`"query_security_knowledge_base"`, `description` containing a plain-English
explanation of what the tool does and when to use it, and `input_schema`
describing the parameters. This definition is appended to the `TOOLS` list in
`terraform_service.py`, and that list is passed to every `client.messages.create()`
call in the agentic loop in `agent_service.py`. The Anthropic model receives
all four tool definitions as part of the API request and reads their
descriptions at inference time. When the model determines that the user's
message is asking about security recommendations or compliance requirements —
which matches the trigger language in the RAG tool's description — it emits a
`tool_use` content block rather than a plain-text response. The agentic loop
detects `stop_reason == "tool_use"`, calls `dispatch_tool()` in
`terraform_service.py`, which routes to `handle_rag_tool_call()`, runs the
retrieval, and packages the result as a `tool_result` message to feed back
into the next API call. The model never runs Python code itself — it only
signals intent, and the Python dispatch layer does the actual work.

---

## If You Had to Build This Again From Scratch

1. Install the four required packages — `chromadb==1.5.7`,
   `sentence-transformers==2.7.0`, `pypdf2==3.0.1`, and
   `python-multipart==0.0.9` — and verify each imports without error before
   writing a single line of application code.

2. Create `backend/rag/__init__.py` as an empty file to make the directory
   a Python package importable with `from rag.knowledge_base import ...`.

3. Write `backend/rag/knowledge_base.py` with the `SecurityKnowledgeBase`
   class, implementing `chunk_text()`, `add_document()`, `search()`,
   `delete_document()`, and `list_documents()`, and add the module-level
   singleton `knowledge_base = SecurityKnowledgeBase()` at the bottom.

4. Write `backend/rag/seed_knowledge.py` with the `SEED_DOCUMENTS` list
   containing at least one document per major service type, implement `seed_all()`,
   and run `cd backend && python -m rag.seed_knowledge` to populate ChromaDB
   and verify the spot-check queries return non-zero relevance scores.

5. Write `backend/rag/rag_service.py`, implementing `build_augmented_prompt()`
   with the no-results fallback, `query_knowledge_base()` with the threshold
   filter and optional resource filter, `RAG_TOOL_DEFINITION` with a description
   precise enough for the model to know when to call it, and `handle_rag_tool_call()`
   as the dispatch target.

6. Add the five RAG endpoints to `backend/main.py` — `POST /rag/query`,
   `POST /rag/documents/upload`, `POST /rag/documents/text`,
   `GET /rag/documents`, and `DELETE /rag/documents/{doc_id}` — and test each
   with curl or the Swagger UI at `http://localhost:8000/docs` before touching
   the frontend.

7. Register the RAG tool in `backend/services/terraform_service.py` by
   importing `RAG_TOOL_DEFINITION` and `handle_rag_tool_call` and appending
   `RAG_TOOL_DEFINITION` to the `TOOLS` list, then add the dispatch branch
   for `"query_security_knowledge_base"` in `dispatch_tool()`.

8. Build the frontend `KnowledgeBasePanel.jsx` component with two tabs —
   Query and Manage Documents — wiring the Query tab to `POST /rag/query` and
   the Manage tab to the upload, text ingest, list, and delete endpoints.

9. Import `KnowledgeBasePanel` in `Dashboard.jsx` and add it as a full-width
   panel at the bottom of the grid, then open the browser and verify the panel
   loads, the document list populates on mount, and a test query returns a
   grounded answer with visible source chips.

10. Write the documentation last — once everything is verified working, read
    the actual source files to confirm exact function names, line numbers, and
    chunk counts, and document what was actually built rather than what was
    planned, because the two are rarely identical.
