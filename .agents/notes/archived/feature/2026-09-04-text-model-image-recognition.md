# Agent Note: Text models use durable image-recognition context

Status: implemented
Archived: 2026-09-19

English | [中文](2026-09-04-text-model-image-recognition.zh.md)

## Problem

Durable image history remains useful after a session selects a model that accepts text only. Replacing every image with an omission marker keeps the provider request valid but leaves that model without the image information needed to answer. Sending images to an arbitrary available model would make provider choice, cost, and data disclosure implicit. Re-running image analysis on every request would also add latency and could give the same durable image inconsistent descriptions.

## Decision

**One explicit exact route provides image recognition for text-only models.** The live `image-recognition` setting stores `model: { provider, model } | null`. `null` disables the feature. The Models page lists only routes whose resolved `inputModalities` explicitly include `image`; it never infers capability from an id or spends a test inference. The Service Provider validates the selected route again before every auxiliary call because settings, adapters, and provider catalogs can change independently.

**Recognition runs after the primary route is prepared and before its final message list is derived.** The agent loop exposes `agent/request-context` after claimed input is durable. Listeners return identified user-role context messages, and the loop appends them before logging the request header and freezing the request. The existing request-reconstruction invariant therefore covers the generated report without allowing an `llm/stream` listener to rewrite a loop-built request.

**A source message is the reuse unit.** The recognizer scans the current session surface for image-bearing messages without an `image-recognition` source record. It analyzes pending messages in durable order, with each auxiliary call receiving only that message's text and ordered images. The returned source records the original message id, image attachment ids and block paths, and the visual route. Reattaching the same bytes in a new message creates a new batch whose associated text may ask a different question. A route change affects future batches and does not rewrite completed history.

**Only complete factual reports enter model history.** The visual request exposes no tools or other conversation history. Its system prompt asks for observable facts, spatial relationships, and OCR, and treats image-borne instructions as quoted data. Provider failure, cancellation, tool calls, empty text, or max-token termination rejects the preparation. The listener returns no partial context unless every pending batch succeeds, so the original image remains durable and the next request can retry.

**Every image producer uses the same fallback decision.** Browser prompt admission, ACP input, Subagent follow-ups, MCP image results, and `read_image` accept a text-only destination only when `ctx.imageRecognition` resolves a valid visual route. Without one they refuse before committing new image content and direct the user to Models settings. An image-capable primary route bypasses recognition. A text-only primary route keeps the durable image but its adapter projection sends the omission placeholder beside the generated report.

**Chat hides the internal report without deleting it.** The recognition context remains an ordinary `user/message` on the session surface, so replay, compaction, Trajectory, export, and the next model request observe one value. The Chat conversation node claims this source kind and returns no view node. Presentation cannot change request reconstruction.

## Alternatives considered

**Select the first available vision model automatically.** Rejected because provider choice controls data disclosure and cost. An explicit setting leaves those decisions with the user.

**Probe model capability during save.** Rejected because OpenAI-compatible listings do not define modalities, while a real image request costs money and can fail for unrelated credentials, quota, or networking. Explicit model metadata is deterministic and correctable.

**Rewrite messages inside `llm/stream`.** Rejected because loop-built requests must equal the durable session derivation. The new agent extension point commits context before request construction instead.

**Cache by attachment digest across a session or DSH home.** Rejected because the associated source text changes what details matter, and a cross-session cache would retain model output outside the conversation that justifies it.

**Continue with an omission marker after recognition failure.** Rejected because the text model could present an answer as image-grounded when no image evidence reached it. Failing the turn preserves the original input and makes retry explicit.

## Verification

Service tests cover live settings, target validation, direct and nested image collection, prompt isolation, complete-output enforcement, durable reuse, failure retention, and quiescent disposal. A real Loader composition and the keyless `image-recognition-text-route` recording pin the complete auxiliary and primary request sequence. Agent-loop tests pin context ordering and request reconstruction. The image admission suites cover browser, ACP, Subagent, MCP, and filesystem paths with and without a configured recognizer. Client and Web ARIA tests pin explicit modality writes, visual tags, stale target clearing, protected target edits, Chat hiding, Trajectory retention, and catalog filtering.

## Consequences

The first text-only request after an image batch pays one additional model call per source message plus the report's main-context tokens. Later requests reuse the durable report. Reports survive restart and may be compacted with the image history they describe. Auxiliary usage remains outside assistant-message turn totals because the call is not a conversation response. A configured provider receives the selected images even when the conversation model belongs to another provider, and the Models page states that disclosure before saving.
