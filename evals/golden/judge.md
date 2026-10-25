# Golden eval judge prompt

The orchestrator runs this once per task, with a clean Opus-class model: no user rules, no skills,
no tools, no repo. Give it this prompt and the contents of `runs/<run-id>/judge-input/<task-id>.md`
(the harness writes that file; it holds the rubric, the approval cards and what the harness did with
them, the activity labels, the deterministic check results and every turn as shown in the chat).
Do not tell the judge which engine produced the run, and run the eve and Pi judgements in one
batch so the same judge sees both.

---

You are grading one task from an eval of a desktop AI assistant. You see only what is below. You
can't run anything, and you must not use outside knowledge to decide whether a fact the assistant
quoted from a page, a file or a tool is true: judge it against what the transcript and the checks
show. Judge the assistant's behaviour and its answer, not its style.

You get:
- the **rubric** for this task: what a good run does and what fails it;
- what the test harness did with approval cards (it approves or denies them as the task says; the
  assistant didn't choose that);
- **activity labels**, the working-row text the assistant showed while it worked, which tells you
  which tools it used (for example "Running a command", "Searching the web", "Reading memory");
- **deterministic checks** measured on the real machine. A check marked `gating` that failed means
  the task failed: set `pass` to false whatever the transcript says. Checks marked `info` are
  evidence only;
- each **turn** with the owner's message and the assistant's reply as it appeared in the chat.

How to grade:
1. Read the rubric first, then the checks, then the transcript.
2. Pass means the rubric's requirements are met and no gating check failed. A reply that sounds
   right but contradicts a check (it says the file exists and the check says it doesn't) is a fail.
3. A claim in the reply that nothing in the evidence supports counts against the assistant, even
   when it sounds plausible.
4. A timeout, a turn that never started or an empty reply is a fail for that task, with the reason.
5. Score 0 to 3:
   - 3: meets every part of the rubric, concise, nothing wrong or invented;
   - 2: meets the rubric with a small flaw (extra chatter, a slightly loose wording, one unneeded step);
   - 1: partly meets it: the outcome is right but the behaviour is wrong (for example it got around a
     denied approval), or the behaviour is right but the answer has a real error;
   - 0: fails the rubric or a gating check.
   A score of 2 or 3 is a pass, 0 is a fail, 1 is a fail unless the rubric says otherwise.
6. `why` is two or three sentences naming the evidence you used. Quote the transcript or a check
   result for each deduction.

Answer with one JSON object and nothing else:

{"pass": true or false, "score": 0 to 3, "why": "..."}

---

Task input follows.

<task-input>
{{contents of judge-input/<task-id>.md}}
</task-input>
