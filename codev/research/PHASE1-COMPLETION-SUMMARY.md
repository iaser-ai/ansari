# Phase 1 Completion Summary: Research & Design

**Date**: 2026-11-22
**Protocol**: SPIR
**Spec**: 360-whatsapp-non-streaming-answer-endpoint
**Phase**: 1 (Research & Design)
**Status**: ✅ COMPLETED

## Overview

Phase 1 of the SPIR protocol has been successfully completed. All research tasks have been executed, and a comprehensive design document has been created with clear recommendations for implementation.

## Research Documents Created

### 1. WhatsApp Message Components (1.1)
**File**: `codev/research/1.1-whatsapp-message-components.md`

**Key Findings:**
- WhatsApp supports limited markdown: `*bold*`, `_italic_`, `~strikethrough~`, `` `monospace` ``
- 4096 character limit per message
- URLs are auto-linked
- Arabic text requires RTL support
- No support for headings, tables, or complex formatting

**Components Identified:**
1. Text content (markdown to WhatsApp conversion)
2. Citations/footnotes (inline text with source attribution)
3. Quran/Hadith references (Arabic + English + reference)
4. Tool call results (structured data to readable text)
5. Code blocks (monospace or split)
6. Lists (bullet/number format)
7. Links (auto-linked)

**Recommendation**: Move existing WhatsApp formatter from `apps/whatsapp` to `apps/api` as a shared utility.

### 2. LLM Structured Output (1.2)
**File**: `codev/research/1.2-llm-structured-output.md`

**Methods Evaluated:**
1. JSON Schema with `responseMimeType: 'application/json'`
2. Function Calling
3. Prompt Engineering (no structured output)
4. Hybrid Approach (JSON Schema + prompt engineering)

**Recommendation**: Use **Hybrid Approach (Method 4)**
- JSON Schema for structure
- Prompt engineering for formatting rules
- Type-safe response
- Easy to modify and maintain

**Example Schema:**
```json
{
  "type": "object",
  "properties": {
    "messages": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Array of WhatsApp-formatted messages, each ≤4096 chars"
    }
  },
  "required": ["messages"]
}
```

### 3. Smart Text Splitting (1.3)
**File**: `codev/research/1.3-smart-text-splitting.md`

**Options Evaluated:**
1. `llm-chunk` - Simple, fast library
2. LangChain's `RecursiveCharacterTextSplitter` - Sophisticated but heavy
3. `llm-splitter` - Fast, lightweight
4. Custom Regex-Based Splitting - No dependencies
5. Hybrid Approach (Paragraph → Sentence → Word) - Custom implementation

**Recommendation**: Use **Custom Hybrid Approach (Option 5)**
- No new dependencies
- Full control over splitting logic
- Handles edge cases well
- Easy to add continuation markers

**Algorithm:**
1. Try paragraphs first (split by `\n\n`)
2. If paragraph too long, split by sentences (split by `. `)
3. If sentence too long, split by words (split by ` `)
4. Add continuation markers (e.g., " (1/3)")

### 4. Thread Lifecycle (1.4)
**File**: `codev/research/1.4-thread-lifecycle.md`

**Current State:**
- Thread lifecycle managed in WhatsApp layer
- One thread per user
- Thread replaced after 3 hours of inactivity

**Proposed Changes:**
- Move thread lifecycle to API layer
- Thread expiry is user-configurable (0-24 hours, default 3 hours)
- Thread identified by user ID + source
- Database transaction with row-level locking for race conditions

**New Endpoint**: `POST /api/v2/chat/complete`

**Request:**
```json
{
  "message": "What does the Quran say about patience?",
  "expiryHours": 3
}
```

**Response:**
```json
{
  "messages": [
    "*Quran 2:153* (Al-Baqarah)\n\"O you who have believed, seek help through patience and prayer...\"",
    "The Quran emphasizes patience as a means of divine support."
  ]
}
```

### 5. Design Document (1.5)
**File**: `codev/research/1.5-design-document.md`

**Comprehensive Design Recommendations:**

#### API Endpoint
- Path: `POST /api/v2/chat/complete`
- Authentication: JWT from Authorization header
- Request: `{ message: string, expiryHours?: number }`
- Response: `{ messages: string[] }`

#### Thread Lifecycle
- Thread identified by user ID + source
- Thread expiry checked at start of each request
- Database transaction with row-level locking
- Cleanup old threads when creating new ones

#### LLM Integration
- Hybrid approach: JSON Schema + prompt engineering
- Structured output with `responseMimeType: 'application/json'`
- Type-safe response

#### Text Splitting
- Custom hybrid approach
- Paragraph → Sentence → Word splitting
- Continuation markers

#### WhatsApp Formatting
- Convert markdown to WhatsApp format
- Handle Arabic text (RTL support)
- Handle tool call results

## Implementation Plan

### Phase 2: API Endpoint Implementation
1. Create endpoint: `POST /api/v2/chat/complete`
2. Implement thread lifecycle: Create, reuse, expire threads
3. Integrate with Gemini: Use structured output
4. Implement text splitting: Split long responses
5. Add WhatsApp formatting: Convert markdown to WhatsApp format
6. Add tests: Unit and integration tests

### Phase 3: WhatsApp Service Updates
1. Update WhatsApp service: Call new endpoint
2. Remove thread management: From WhatsApp layer
3. Handle response: Loop through messages and send
4. Add error handling: Retry logic, error messages
5. Update tests: Unit and integration tests

### Phase 4: Testing & Validation
1. Unit tests: Test each component
2. Integration tests: Test end-to-end flow
3. Manual tests: Test with real WhatsApp Business API
4. Performance tests: Test with various message sizes
5. Edge case tests: Test with various inputs

### Phase 5: Documentation & Deployment
1. Update API documentation: Document new endpoint
2. Update environment variables: If needed
3. Deploy to staging: Test in staging environment
4. Deploy to production: Roll out to production
5. Monitor: Monitor for issues

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| LLM doesn't follow WhatsApp format | Medium | Medium | Use structured output; test with various prompts |
| Text splitting breaks formatting | Medium | Medium | Use smart splitting; test edge cases |
| Thread race conditions | Medium | High | Use database transactions with row-level locking |
| JWT expires mid-request | Low | Medium | Same as streaming; 401 triggers re-exchange |
| Answer too large for single response | Low | Low | HTTP handles large bodies; pre-split into list |
| WhatsApp formatting not supported | Low | Low | Document limitations; fallback to plain text |
| Thread lifecycle logic duplicated | Low | Low | Extract to shared helper |
| User-configurable expiry not in Meta API | Medium | Low | Use default 3 hours initially; add user preferences later |

## Success Criteria

- [ ] WhatsApp service can call a single endpoint and get a complete answer as a list of messages
- [ ] Thread lifecycle (create/reuse based on user-configurable expiry, default 3 hours) works correctly
- [ ] Authentication uses the same JWT flow (BSUID → apps/auth → JWT → apps/api)
- [ ] Answer text is complete and identical to what streaming would produce
- [ ] LLM (Gemini) returns WhatsApp-formatted text (using structured output/function calling)
- [ ] Response is split into WhatsApp-sized chunks (4096 chars) at paragraph/sentence boundaries
- [ ] Errors are returned as HTTP status codes with JSON error bodies
- [ ] No streaming logic remains in WhatsApp service for answer retrieval
- [ ] Unit and integration tests cover the new endpoint

## Next Steps

1. **Review Phase 1**: Stakeholder review of research findings and design recommendations
2. **Update Spec**: Incorporate design decisions into the spec
3. **Create Implementation Plan**: Detailed plan for Phase 2-5
4. **Begin Implementation**: Start with Phase 2 (API endpoint)

## Conclusion

Phase 1 has successfully completed all research tasks and produced a comprehensive design document with clear recommendations for implementation. The design addresses all key requirements:

- ✅ WhatsApp message formatting
- ✅ LLM structured output
- ✅ Smart text splitting
- ✅ Thread lifecycle management
- ✅ User-configurable expiry
- ✅ Error handling
- ✅ Testing strategy

The project is ready to proceed to Phase 2 (API Endpoint Implementation) upon approval.

---

**Prepared by**: Builder SPIR 360
**Date**: 2026-11-22
**Status**: Ready for Review