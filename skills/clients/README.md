# Client Skills (Client Knowledge Base)

This folder contains client-specific knowledge files. Mia loads these alongside platform skills to give client-aware answers.

## How to add a new client

1. Create a new `.md` file named after the client: `barimelts.md`, `clientname.md`
2. Include: brand overview, products, audience, compliance rules, ad account IDs, brand voice
3. Commit — Mia auto-discovers and loads client knowledge, no code changes needed

## What to include in a client file

- Brand overview and positioning
- Product catalog and USPs
- Target audience segments
- Brand voice and tone guidelines
- Compliance rules (FDA, ad policies, etc.)
- Ad account IDs and platforms used
- Creative guidelines
- Key metrics and KPIs to track

## Important

The file name must match the client name in the ACCOUNTS env variable (lowercased, alphanumeric only).
Example: If ACCOUNTS has "Barimelts:746-735-8073", the file should be `barimelts.md`

## Current Clients

- Barimelts: Currently at `/barimelts-knowledge.md` in root (backward compatible)
