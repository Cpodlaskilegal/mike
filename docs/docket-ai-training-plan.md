# Docket Lightweight Tutorial and Training Video Script

Draft date: 2026-06-30

This document defines the lightweight Docket in-app tutorial and matching
training video script. It is intentionally practical: the tutorial should teach
the normal first-use workflow, not create a heavy compliance gate.

## Goal

Teach a new Docket user how to safely start work on a matter:

- Create a project for the matter.
- Upload the matter files needed for the task.
- Open a chat from the project.
- Choose the right model.
- Prompt Docket with jurisdiction, task, and drafting preferences.
- Review and accept proposed document changes.
- Export attorney-reviewed work product.
- Treat AI output as draft work that must be checked before use.

## Recommended Tutorial Format

Use a simple guided checklist or lightweight walkthrough in the app. Do not
build a full policy-training system for this phase.

Recommended shape:

- Show the tutorial from a `Help` or `Start here` action.
- Let users dismiss it and reopen it.
- Store only a local "seen" flag at first, such as `docket:tutorial-seen`.
- Use short cards or anchored tips on existing screens.
- Keep the walkthrough to 5 to 7 minutes.
- Avoid quizzes, annual retraining, admin revocation, backend route gates, role
  matrices, and durable compliance records unless the firm later asks for a
  formal policy-training module.

## In-App Tutorial Flow

### 1. Create a Project

Screen: Projects

Message:

"Start by creating a project for the matter you want to work on. Use the matter
name or case caption so it is easy to confirm that you are working in the right
place."

User action:

- Click `New Project`.
- Enter the matter name.
- Add the matter or case number if available.

Safety note:

"Confirm the project before uploading files. If documents are placed in the
wrong matter, stop and correct or escalate before using them."

### 2. Upload Matter Files

Screen: New Project modal or Project Documents tab

Message:

"Upload the documents Docket needs for this task. For a drafting request, upload
the key matter documents and any pleadings, correspondence, exhibits, contracts,
or prior versions that should guide the answer."

User action:

- Upload the relevant matter files.
- Organize files in the project if needed.
- Use only documents needed for the task.

Prompting tip:

"When asking for a draft, Docket will try to find a similar filed pleading or
Box toolbox form before drafting from scratch. Upload a specific example if you
want that source used."

Safety note:

"Do not upload unrelated client files or unnecessary confidential material."

### 3. Open a Chat

Screen: Project page

Message:

"Open chat from inside the project so Docket can use the matter files you
uploaded. Project chat keeps the conversation tied to the documents and context
for that matter."

User action:

- Click the project chat or assistant tab.
- Attach or select the documents that should be used.
- Ask a specific task-oriented question.

Good prompt example:

"Draft a first version of a motion to compel for Indiana state court. Use the
uploaded discovery requests, deficiency letter, and example motion as source
materials. Preserve the tone and structure of the example. Flag any facts or
citations that need attorney confirmation."

### 4. Choose a Model

Screen: Chat input model picker

Message:

"Use the model picker based on task difficulty. We recommend GPT-5.5 for most
legal drafting, review, and analysis. Use GPT-5.5 Pro for harder tasks that
need deeper reasoning, more careful synthesis, or higher-stakes drafting."

Model guidance:

- `GPT-5.5`: recommended default for normal drafting, review, summaries, issue
  spotting, and document questions.
- `GPT-5.5 Pro`: use for complex briefs, difficult legal analysis, dense record
  review, multi-document synthesis, or important client-ready drafts.

Warning:

"GPT-5.5 Pro can take much longer. Use it when the added reasoning time is worth
the wait."

### 5. Give Docket the Jurisdiction and Task

Screen: Chat input

Message:

"Tell Docket the jurisdiction, forum, role, and output you need. Docket should
not have to guess the law or procedural context."

Include in prompts:

- Jurisdiction, such as Indiana, federal court, county, agency, or contract
  governing law.
- Document type, such as motion, demand letter, complaint, memo, discovery
  chart, or client letter.
- Audience, such as court, client, opposing counsel, internal attorney review,
  or paralegal summary.
- Desired style, length, format, and deadline.
- Whether Docket should cite uploaded documents, legal authorities, or both.

Bad prompt:

"Draft this."

Better prompt:

"Draft a client-ready demand letter under Indiana law using the uploaded
contract, invoice history, and example demand letter. Keep the tone firm but
professional. Identify any facts, dates, or legal authorities I need to verify."

### 6. Review and Accept Changes

Screen: Generated document or document preview

Message:

"Docket can propose text and tracked changes. Review every proposed change
before accepting it. Make sure the revision says exactly what you intend and
that it fits the document."

User action:

- Read the generated text.
- Compare it to the source documents.
- Accept only correct changes.
- Reject, edit, or regenerate weak language.
- Confirm formatting, numbering, headings, styles, captions, signatures, and
  exhibits.

Safety note:

"Do not accept changes just because they are grammatically clean. Confirm the
substance."

### 7. Export Documents

Screen: Document preview or generated output

Message:

"Export only after human review. The exported document should be treated like
any other draft work product prepared for attorney review or final use."

User action:

- Export the reviewed document.
- Open the exported file.
- Check layout, styles, numbering, signature blocks, page breaks, and exhibits.
- Save the final version through the firm's normal matter-file process.

Safety note:

"If the document will go to a client, opposing counsel, court, agency, or third
party, attorney review is required before it leaves the firm."

### 8. AI Output Warning

Screen: Final tutorial card and optional persistent help page

Message:

"Docket output is AI-generated draft work. You are responsible for reviewing it
before use."

Required warnings:

- Confirm all citations and authorities before relying on them.
- Open and read cited cases, statutes, rules, regulations, and source
  documents.
- Check that quotations match the source.
- Review all text for accuracy, completeness, tone, and legal judgment.
- Confirm names, dates, amounts, deadlines, procedural posture, and case
  numbers.
- Ensure formatting, styles, captions, signature blocks, exhibits, numbering,
  and page breaks are correct.
- Do not send, file, or rely on raw Docket output without human review.

## Suggested In-App Copy

Use this as the concise tutorial text if space is limited:

1. "Create a project for the matter you want to work on."
2. "Upload the matter files Docket should use."
3. "For drafts, Docket will try to find a similar filed pleading or Box toolbox
   form. Upload a specific example if you want that source used."
4. "Open chat from the project so the conversation uses the right matter
   context."
5. "Choose GPT-5.5 for most work. Choose GPT-5.5 Pro for harder tasks, but
   expect it to take longer."
6. "State the jurisdiction, forum, task, audience, and desired output."
7. "Review every proposed change before accepting it."
8. "Export only after checking the document."
9. "Confirm citations, authorities, facts, formatting, and all text before
   sending, filing, or relying on AI-generated content."

## Training Video Script

Target length: 4 to 6 minutes

Tone: practical, direct, and user-focused. This is a short product walkthrough,
not a compliance lecture.

### 0:00-0:25 - Opening

Visual:

- Docket Projects screen.
- Quick cuts to a project, uploaded documents, chat, model picker, document
  preview, and export.

Narration:

"This short walkthrough shows the normal way to start using Docket on a matter:
create a project, upload the matter files, open a chat, choose the right model,
ask a specific question, review changes, and export only after checking the
work."

On-screen text:

- Project.
- Files.
- Chat.
- Review.
- Export.

### 0:25-1:05 - Create a Project

Visual:

- Click `New Project`.
- Enter a matter name and optional matter number.
- Open the new project.

Narration:

"Start by creating a project for the matter you want to work on. Name it clearly
so you can confirm you are in the right place before uploading documents or
asking questions. If you have a matter number or case number, add it."

On-screen checklist:

- Matter name.
- Case or matter number.
- Confirm before upload.

### 1:05-1:55 - Upload Matter Files

Visual:

- Upload pleadings, correspondence, exhibits, contracts, or discovery.
- Show the project documents list.
- Add an example filing or client-ready document.

Narration:

"Next, upload the matter files Docket needs for the task. For a drafting
request, include the key source documents. Docket will try to find a similar
filed pleading or Box toolbox form before drafting from scratch. Upload a
specific example if you want that source used."

On-screen text:

- Upload only what is needed.
- Include source documents.
- Add a specific example if you want that source used.

### 1:55-2:45 - Open Chat and Choose a Model

Visual:

- Open chat from the project.
- Select documents for the chat if shown.
- Open the model picker.
- Highlight GPT-5.5 and GPT-5.5 Pro.

Narration:

"Open chat from inside the project so Docket uses the right matter context. Then
choose the model. GPT-5.5 is the recommended default for most drafting,
summaries, review, and analysis. Use GPT-5.5 Pro for harder tasks like complex
briefs, dense record review, difficult legal analysis, or important client-ready
drafts. GPT-5.5 Pro can take much longer, so use it when the extra reasoning is
worth the wait."

On-screen text:

- GPT-5.5: recommended default.
- GPT-5.5 Pro: harder tasks, longer wait.

### 2:45-3:35 - Ask a Good Question

Visual:

- Type a weak prompt: "Draft this."
- Replace it with a complete prompt.

Narration:

"Be explicit. Tell Docket the jurisdiction, forum, task, audience, and output
you need. Do not make Docket guess. A better prompt is: 'Draft a client-ready
demand letter under Indiana law using the uploaded contract, invoice history,
and example demand letter. Keep the tone firm but professional. Identify any
facts, dates, or legal authorities I need to verify.'"

On-screen checklist:

- Jurisdiction.
- Forum.
- Task.
- Audience.
- Desired format.
- Sources to use.

### 3:35-4:30 - Review and Accept Changes

Visual:

- Show generated text or tracked changes.
- Accept one change.
- Edit or reject another.
- Compare a citation or quote to the source.

Narration:

"Docket's output is draft work. Review every proposed change before accepting
it. Make sure the text is accurate, complete, and appropriate for the document.
Check the source documents, citations, quotations, names, dates, amounts,
deadlines, and procedural posture. Do not accept text just because it sounds
polished."

On-screen text:

- Review every change.
- Verify facts and citations.
- Edit or reject weak language.

### 4:30-5:15 - Export and Final Check

Visual:

- Export a document.
- Open the exported file.
- Check formatting, headings, numbering, page breaks, signature block, and
  exhibits.

Narration:

"Export only after review. Open the exported file and check the formatting:
styles, headings, numbering, captions, page breaks, signature blocks, exhibits,
and anything else that matters for the final document. If the document is going
to a client, opposing counsel, court, agency, or third party, attorney review is
required before it leaves the firm."

On-screen checklist:

- Open exported file.
- Check formatting and styles.
- Attorney review before sending or filing.

### 5:15-5:55 - AI-Generated Content Warning

Visual:

- Final warning card.
- Highlight citations, authorities, text review, and formatting.

Narration:

"Docket can save time, but you remain responsible for the work product. Confirm
all citations and authorities. Review every sentence. Make sure formatting and
styles are correct. Do not send, file, or rely on raw AI-generated content
without human review."

On-screen text:

- Confirm citations and authorities.
- Review all text.
- Check formatting and styles.
- Do not rely on raw AI output.

## One-Page User Reminder

- Create a project for the matter.
- Upload the matter files needed for the task.
- For drafting, Docket will try to find a similar filed pleading or Box toolbox
  form. Upload a specific example if you want that source used.
- Open chat from the project.
- Use GPT-5.5 for most work.
- Use GPT-5.5 Pro for harder tasks, with a longer wait.
- State the jurisdiction, forum, task, audience, and output.
- Review and accept changes one by one.
- Export only after checking the document.
- Confirm citations, authorities, facts, text, formatting, and styles before
  sending, filing, or relying on Docket output.
