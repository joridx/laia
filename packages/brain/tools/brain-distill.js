import { z } from "zod";
import { planDistillation, getDistillStatus, generateDrafts, approveDraft, rejectDraft } from "../distillation.js";

export const name = "brain_distill";

export const description = "Periodic distillation workflow. action: plan|generate|status|approve|reject";

export const schema = {
  action: z.enum(["plan", "generate", "status", "approve", "reject"]).describe("Workflow action"),
  draft_id: z.string().optional().describe("Draft ID for approve/reject"),
  limit: z.number().optional().describe("Max drafts to generate (default 3)"),
  force: z.boolean().optional().describe("Force re-plan ignoring cooldown"),
  edited_content: z.string().optional().describe("Edited principle content for approve")
};

export async function handler({ action, draft_id, limit, force, edited_content } = {}) {
  if (action === "plan") {
    const result = planDistillation({ force: force || false });
    if (result.skipped) {
      return { content: [{ type: "text", text: `Skipped (within cooldown). ${result.totalPending} pending clusters. Use force:true to re-plan.` }] };
    }
    return { content: [{ type: "text", text: `Plan complete.\n- New clusters queued: ${result.newClusters}\n- Total pending: ${result.totalPending}` }] };
  }

  if (action === "generate") {
    const result = await generateDrafts({ limit: limit || 3 });
    return { content: [{ type: "text", text: `Draft generation complete.\n- Generated: ${result.generated}\n- Skipped (budget): ${result.skippedBudget}\n- Skipped (LLM unavailable): ${result.skippedLlm}\n\nRun action:status to review drafts.` }] };
  }

  if (action === "status") {
    const status = getDistillStatus();
    const lines = [
      "# Distillation Status",
      `- Pending: ${status.pending} | Drafted: ${status.drafted} | Approved: ${status.approved} | Rejected: ${status.rejected} | Stale: ${status.stale || 0}`,
      `- Last plan: ${status.lastPlanAt || "never"}`,
    ];
    if (status.draftedItems.length > 0) {
      lines.push("\n## Drafts Ready for Review");
      for (const d of status.draftedItems) {
        lines.push(`\n### ${d.title}`);
        lines.push(`- Draft ID: \`${d.draftId}\``);
        lines.push(`- Tags: ${(d.tags || []).map(t => `#${t}`).join(", ")}`);
        lines.push(`- Sources (${d.sources.length}): ${d.sources.join(", ")}`);
        lines.push(`\n${d.content}`);
        lines.push(`\n- Approve: brain_distill(action:approve, draft_id:${d.draftId})`);
        lines.push(`- Reject:  brain_distill(action:reject,  draft_id:${d.draftId})`);
      }
    }
    if (status.pendingItems.length > 0) {
      lines.push(`\n## Pending Clusters (${status.pending})`);
      for (const p of status.pendingItems.slice(0, 5)) {
        lines.push(`- [${p.size} notes, sim ${p.avgSimilarity}] ${p.sourceSlugs.slice(0, 3).join(", ")}${p.sourceSlugs.length > 3 ? "..." : ""}`);
      }
      lines.push(`\nRun brain_distill(action:generate) to generate drafts.`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (action === "approve") {
    if (!draft_id) return { content: [{ type: "text", text: "Error: draft_id required" }] };
    const result = approveDraft(draft_id, { editedContent: edited_content });
    if (!result.ok) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    return { content: [{ type: "text", text: `Approved: principle saved as ${result.principleSlug}\n- ${result.archivedSources} source notes archived.` }] };
  }

  if (action === "reject") {
    if (!draft_id) return { content: [{ type: "text", text: "Error: draft_id required" }] };
    const result = rejectDraft(draft_id);
    if (!result.ok) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    return { content: [{ type: "text", text: "Draft rejected." }] };
  }

  return { content: [{ type: "text", text: "Unknown action. Use: plan | generate | status | approve | reject" }] };
}
