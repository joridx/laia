/**
 * Tool: brain_remember
 * Save knowledge to brain. Single: content+tags+type. Batch: learnings[] array.
 */

import { z } from "zod";

import { LEARNINGS_DIR } from "../config.js";
import { readFile, writeFile } from "../file-io.js";
import { addTagCooccurrenceRelations, addBridgeGraphEdges } from "../graph.js";
import {
  recordLearningHitsBySlugs, ensureLearningMeta,
  findSimilarLearning, generateRelatedSection,
  classifyMergeAction, mergeLearningAppend, markSuperseded
} from "../learnings.js";
import {
  slugify, sanitizeTag, buildLearningMarkdown, applyTagAliases
} from "../utils.js";
import {
  isLlmAvailable, llmAutoTags, llmAssessValue, getBudgetWarning
} from "../llm.js";
import {
  isEmbeddingsAvailable, embedText, buildEmbeddingText,
  computeEmbeddingHash, embeddingToBlob, getEmbeddingStats
} from "../embeddings.js";
import { syncLearningEmbedding } from "../database.js";
import { updateEmbeddingCacheEntry } from "../search.js";
import { zCoercedArray, getTagAliasMap } from "./shared.js";

export const name = "brain_remember";
export const description = "Save knowledge to brain. Single: content+tags+type. Batch: learnings[] array. domain for reference knowledge.";
export const schema = {
  content: z.string().optional().describe("Content to remember (single mode)"),
  tags: zCoercedArray(z.string()).optional().describe("Tags (single mode)"),
  type: z.enum(["learning", "pattern", "warning", "principle", "bridge", "procedure"]).optional().describe("Type: learning, pattern, warning, principle, bridge, procedure"),
  connects: zCoercedArray(z.string()).optional().describe("Bridge type only: concept slugs this bridge connects, e.g. ['python-http', 'corporate-ssl']"),
  domain: z.string().optional().describe("Save to knowledge/{domain}/ instead of learnings"),
  force: z.boolean().optional().describe("Bypass similarity gate"),
  supersedes: zCoercedArray(z.string()).optional().describe("Slugs this learning supersedes (marks old ones as superseded)"),
  // V4 Sprint 1A: Procedure fields
  trigger_intents: zCoercedArray(z.string()).optional().describe("Procedure: intents that trigger this procedure (e.g. ['deploy', 'release'])"),
  preconditions: zCoercedArray(z.string()).optional().describe("Procedure: conditions that must be true before executing"),
  steps: z.number().optional().describe("Procedure: number of steps in the body"),
  // V4 Sprint 1B: Golden Suite
  protected: z.boolean().optional().describe("Protected learning: immune to decay and prune. Use for critical knowledge."),
  learnings: zCoercedArray(z.object({
    type: z.enum(["warning", "pattern", "learning", "principle", "bridge", "procedure"]).describe("Type: warning, pattern, learning, principle, bridge, or procedure"),
    title: z.string().describe("Short title (becomes heading)"),
    description: z.string().describe("Full description with context"),
    tags: zCoercedArray(z.string()).describe("Relevant tags"),
    connects: zCoercedArray(z.string()).optional().describe("Bridge only: concept slugs this connects"),
    trigger_intents: zCoercedArray(z.string()).optional().describe("Procedure only: trigger intents"),
    preconditions: zCoercedArray(z.string()).optional().describe("Procedure only: preconditions"),
    steps: z.number().optional().describe("Procedure only: number of steps"),
    protected: z.boolean().optional().describe("Protected: immune to decay")
  })).optional().describe("Batch mode: array of learnings to save"),
  session_ref: z.string().optional().describe("Session reference for batch mode"),
  agentProfile: z.string().optional().describe("Agent profile name (V2b). Auto-stored in learning metadata for agent-scoped retrieval."),
  source_type: z.enum(["conversation", "consolidation", "manual", "import"]).optional().describe("P15.0: How the learning was created"),
  source_context: z.string().optional().describe("P15.0: What was being worked on when this was captured"),
  created_by: z.enum(["user", "agent", "system"]).optional().describe("P15.0: Who created this learning"),
  source_ref: z.string().optional().describe("P15.0: External reference (Jira key, commit SHA, URL)")
};

export async function handler({ content, tags, type, connects, domain, force = false, supersedes, learnings, session_ref, agentProfile, source_type, source_context, created_by, source_ref, trigger_intents, preconditions, steps, protected: isProtected }) {
  // P15.0: Build provenance object (only include non-null/non-empty fields)
  const provenance = {};
  if (source_type) provenance.source_type = source_type;
  if (source_context && source_context.trim()) provenance.source_context = source_context.trim();
  if (created_by) provenance.created_by = created_by;
  if (source_ref && source_ref.trim()) provenance.source_ref = source_ref.trim();
  if (session_ref && session_ref.trim()) provenance.source_session = session_ref.trim();
  // Only consider provenance present if at least one meaningful field exists (beyond default created_by)
  const hasProvenance = !!(source_type || (source_context && source_context.trim()) || (source_ref && source_ref.trim()) || (session_ref && session_ref.trim()) || created_by);
  // Apply default created_by only when other provenance fields are present
  if (hasProvenance && !provenance.created_by) provenance.created_by = "agent";

  // ── Batch mode (replaces brain_auto_learn) ──
  if (learnings && learnings.length > 0) {
    const MAX_LEARNINGS = 20;
    const MAX_DESC = 10000;
    if (learnings.length > MAX_LEARNINGS) {
      return { content: [{ type: "text", text: `Error: too many learnings (${learnings.length}, max ${MAX_LEARNINGS})` }] };
    }
    for (const l of learnings) {
      if (l.description.length > MAX_DESC) {
        return { content: [{ type: "text", text: `Error: description too large for "${l.title}" (${l.description.length} chars, max ${MAX_DESC})` }] };
      }
    }

    let saved = { warning: 0, pattern: 0, learning: 0, principle: 0, bridge: 0, procedure: 0 };
    let blocked = 0;
    let merged = 0;
    const details = [];
    const allBatchTags = []; // Accumulate tags for single relations update at end

    for (const learning of learnings) {
      const slug = slugify(learning.title);
      const filePath = `${LEARNINGS_DIR}/${slug}.md`;
      const cleanTags = applyTagAliases(learning.tags.map(sanitizeTag), getTagAliasMap());

      if (readFile(filePath)) {
        details.push(`⏭️ Skipped (exact duplicate): ${learning.title}`);
        continue;
      }

      const similar = await findSimilarLearning(learning.title, cleanTags);
      if (similar?.level === "block") {
        recordLearningHitsBySlugs([similar.slug]);
        const src = similar.source ? ` [${similar.source}]` : "";
        details.push(`🛑 Blocked${src} (similarity ${similar.similarity}): "${learning.title}" → covered by "${similar.title}" (↑ hit_count)`);
        blocked++;
        continue;
      }

      // P12.1: Write-time consolidation — auto-merge if safe
      if (similar?.level === "warn") {
        const action = classifyMergeAction(similar);
        if (action === "merge_safe") {
          const mergeResult = mergeLearningAppend(similar.slug, {
            title: learning.title,
            description: learning.description,
            type: learning.type,
            tags: cleanTags,
          }, similar);
          if (mergeResult.success) {
            details.push(`🔀 ${mergeResult.mergeInfo}`);
            saved[learning.type]++;
            continue;
          }
          // Merge failed — fall through to create new with warning
        }
        const src = similar.source ? ` [${similar.source}]` : "";
        const reason = similar.reason ? ` — ${similar.reason}` : "";
        details.push(`⚠ Saved with warning${src} (similarity ${similar.similarity}): ${learning.title} — similar to "${similar.title}"${reason}`);
      }

      const extra = session_ref ? `\n- **Session**: ${session_ref}\n` : null;
      const related = generateRelatedSection(slug, cleanTags);
      // V4: Build procedure fields and protected flag for batch items
      const batchProcedureFields = learning.type === "procedure" ? {
        trigger_intents: learning.trigger_intents || [],
        preconditions: learning.preconditions || [],
        steps: learning.steps || 0,
        used_count: 0, success_count: 0, last_outcome: null, last_used: null
      } : undefined;
      const fileContent = buildLearningMarkdown(learning.title, learning.type, cleanTags, learning.description, extra, {
        connects: learning.connects,
        provenance: hasProvenance ? provenance : undefined,
        procedureFields: batchProcedureFields,
        protected: learning.protected || (learning.type === "principle")
      }) + related;

      writeFile(filePath, fileContent);
      ensureLearningMeta(slug, learning.title, filePath, learning.type, {
        agentProfile,
        protected: learning.protected || (learning.type === "principle"),
        trigger_intents: learning.trigger_intents,
        preconditions: learning.preconditions,
        step_count: learning.steps,
      });
      allBatchTags.push(...cleanTags); // Defer relations update to batch end

      // P14.1: Bridge auto-graph edges
      if (learning.type === "bridge" && Array.isArray(learning.connects) && learning.connects.length >= 2) {
        addBridgeGraphEdges(learning.connects);
      }

      // P9.2: Embed new learning
      if (isEmbeddingsAvailable()) {
        try {
          const embText = buildEmbeddingText({ title: learning.title, headline: learning.description.split("\n")[0], body: learning.description });
          const embedding = await embedText(embText);
          if (embedding) {
            const hash = computeEmbeddingHash(embText);
            syncLearningEmbedding(slug, embeddingToBlob(embedding), hash, getEmbeddingStats().model);
            updateEmbeddingCacheEntry(slug, embedding);
          }
        } catch { /* embedding failure is non-blocking */ }
      }

      saved[learning.type]++;
      details.push(`✓ ${learning.type}: ${learning.title}`);
    }

    const total = saved.warning + saved.pattern + saved.learning + saved.principle + saved.bridge + saved.procedure;

    // Batch-deferred: single relations.json update with all accumulated tags
    if (allBatchTags.length >= 2) {
      addTagCooccurrenceRelations(allBatchTags);
    }

    let output = `# Auto-Learn Results\n\n`;
    output += `**Saved:** ${total} learnings`;
    if (blocked > 0) output += ` | **Blocked (duplicates):** ${blocked}`;
    output += `\n`;
    output += `- Warnings (#avoid): ${saved.warning}\n`;
    output += `- Patterns (#pattern): ${saved.pattern}\n`;
    output += `- Principles (#principle): ${saved.principle}\n`;
    if (saved.bridge > 0) output += `- Bridges (#bridge): ${saved.bridge}\n`;
    if (saved.procedure > 0) output += `- Procedures (#procedure): ${saved.procedure}\n`;
    output += `- General: ${saved.learning}\n`;
    if (merged > 0) output += `- **Merged into existing:** ${merged}\n`;
    output += `\n`;
    output += `## Details\n`;
    for (const d of details) output += `${d}\n`;

    // LLM auto-tag suggestions for saved learnings (non-destructive, display only)
    if (isLlmAvailable() && total > 0 && total <= 5) {
      try {
        const savedLearnings = learnings.filter(l => details.some(d => d.includes("✓") && d.includes(l.title)));
        for (const l of savedLearnings.slice(0, 3)) {
          const suggested = await llmAutoTags(l.title, l.description, l.tags, getTagAliasMap());
          if (suggested && suggested.length > 0) {
            output += `\n💡 Suggested tags for "${l.title}": ${suggested.map(t => `#${t}`).join(", ")}`;
          }
        }
      } catch {}
    }

    const llmWarningB = getBudgetWarning();
    if (llmWarningB) output += `\n${llmWarningB}`;

    return { content: [{ type: "text", text: output }] };
  }

  // ── Single mode ──
  if (!content || !tags || !type) {
    return { content: [{ type: "text", text: "Error: single mode requires content, tags, and type. For batch mode, pass learnings[] array." }] };
  }

  const MAX_CONTENT = 50000;
  if (content.length > MAX_CONTENT) {
    return { content: [{ type: "text", text: `Error: content too large (${content.length} chars, max ${MAX_CONTENT})` }] };
  }
  const title = content.split("\n")[0];
  const slug = slugify(title);
  const safeDomain = domain ? domain.replace(/[^a-z0-9_-]/gi, "-") : null;
  const filePath = safeDomain
    ? `knowledge/${safeDomain}/${slug}.md`
    : `${LEARNINGS_DIR}/${slug}.md`;
  const cleanTags = applyTagAliases(tags.map(sanitizeTag), getTagAliasMap());

  if (readFile(filePath)) {
    return { content: [{ type: "text", text: `⚠ Already exists: ${filePath}` }] };
  }

  // P14.3: Value assessment gate (LLM-based, non-blocking if LLM unavailable)
  let _valueAssessment = null;
  if (!safeDomain && !force) {
    const assessment = await llmAssessValue(title, content, type);
    if (assessment && assessment.score < 0.3) {
      return { content: [{ type: "text", text: `⛔ Rejected (low value, score ${assessment.score.toFixed(2)}): ${assessment.reason}\nUse force:true to save anyway.` }] };
    }
    _valueAssessment = assessment;
  }

  // V4: Build procedure fields for single mode
  const singleProcedureFields = type === "procedure" ? {
    trigger_intents: trigger_intents || [],
    preconditions: preconditions || [],
    steps: steps || 0,
    used_count: 0, success_count: 0, last_outcome: null, last_used: null
  } : undefined;
  const mdOpts = { connects, provenance: hasProvenance ? provenance : undefined, procedureFields: singleProcedureFields, protected: isProtected || (type === "principle") };

  // P7.1: Similarity gate — only for learnings (not knowledge/ domain files)
  if (!safeDomain && !force) {
    const similar = await findSimilarLearning(title, cleanTags);
    if (similar?.level === "block") {
      const src = similar.source ? ` [${similar.source}]` : "";
      recordLearningHitsBySlugs([similar.slug]);
      return { content: [{ type: "text", text: `🛑 Duplicate blocked${src} (similarity ${similar.similarity}): "${similar.title}" (${similar.slug})\n↑ hit_count incremented on existing learning.\nUse force:true to create anyway.` }] };
    }

    // P12.1: Write-time consolidation — auto-merge if safe
    if (similar?.level === "warn") {
      const action = classifyMergeAction(similar);
      if (action === "merge_safe") {
        const mergeResult = mergeLearningAppend(similar.slug, {
          title,
          description: content,
          type,
          tags: cleanTags,
        }, similar);
        if (mergeResult.success) {
          let resultText = `🔀 ${mergeResult.mergeInfo}\nTags: ${cleanTags.map(t => `#${t}`).join(", ")}`;
          const llmWarningM = getBudgetWarning();
          if (llmWarningM) resultText += `\n${llmWarningM}`;
          return { content: [{ type: "text", text: resultText }] };
        }
        // Merge failed — fall through to create new with warning
      }
      const src = similar.source ? ` [${similar.source}]` : "";
      const reason = similar.reason ? `\n💡 ${similar.reason}` : "";
      const related = generateRelatedSection(slug, cleanTags);
      const fileContent = buildLearningMarkdown(title, type, cleanTags, content, null, mdOpts) + related;
      writeFile(filePath, fileContent);
      ensureLearningMeta(slug, title, filePath, type, { agentProfile, protected: isProtected || (type === "principle"), trigger_intents, preconditions, step_count: steps });
      addTagCooccurrenceRelations(cleanTags);
      return {
        content: [{ type: "text", text: `✓ Remembered: ${filePath}\nTags: ${cleanTags.map(t => `#${t}`).join(", ")}\n⚠ Similar learning exists${src} (similarity ${similar.similarity}): "${similar.title}" (${similar.slug})${reason}` }]
      };
    }
  }

  const related = safeDomain ? "" : generateRelatedSection(slug, cleanTags);
  const fileContent = buildLearningMarkdown(title, type, cleanTags, content, null, mdOpts) + related;
  writeFile(filePath, fileContent);
  if (!safeDomain) {
    ensureLearningMeta(slug, title, filePath, type, {
      agentProfile,
      protected: isProtected || (type === "principle"),
      trigger_intents,
      preconditions,
      step_count: steps,
    });
  }
  addTagCooccurrenceRelations(cleanTags);

  let resultText = `✓ Remembered: ${filePath}\nTags: ${cleanTags.map(t => `#${t}`).join(", ")}`;

  // P14.3: Low-value warning (0.3-0.5 score)
  if (_valueAssessment && _valueAssessment.score < 0.5) {
    resultText += `\n⚠️ Low value score (${_valueAssessment.score.toFixed(2)}): ${_valueAssessment.reason}`;
  }

  // P14.3: Supersession — mark old learnings as superseded
  if (supersedes && supersedes.length > 0 && !safeDomain) {
    const ssResults = markSuperseded(slug, supersedes);
    for (const r of ssResults) {
      if (r.success) {
        resultText += `\n♻️ Superseded: ${r.slug}${r.title ? ` ("${r.title}")` : ""}`;
      } else {
        resultText += `\n⚠ Could not supersede ${r.slug}: ${r.reason}`;
      }
    }
  }

  // LLM auto-tag suggestions (non-destructive, display only)
  if (isLlmAvailable() && !safeDomain) {
    try {
      const suggested = await llmAutoTags(title, content, cleanTags, getTagAliasMap());
      if (suggested && suggested.length > 0) {
        resultText += `\n💡 Suggested additional tags: ${suggested.map(t => `#${t}`).join(", ")}`;
      }
    } catch {}
  }

  // P9.2: Embed new learning and save to DB
  if (isEmbeddingsAvailable() && !safeDomain) {
    try {
      const embText = buildEmbeddingText({ title, headline: content.split("\n")[0], body: content });
      const embedding = await embedText(embText);
      if (embedding) {
        const hash = computeEmbeddingHash(embText);
        syncLearningEmbedding(slug, embeddingToBlob(embedding), hash, getEmbeddingStats().model);
        updateEmbeddingCacheEntry(slug, embedding);
      }
    } catch {}
  }

  const llmWarningS = getBudgetWarning();
  if (llmWarningS) resultText += `\n${llmWarningS}`;

  return { content: [{ type: "text", text: resultText }] };
}
