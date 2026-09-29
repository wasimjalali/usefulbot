import { defineDynamic, defineInstructions } from "eve/instructions";
import { accountFullName, ownerName } from "../../shared/operator.ts";

/**
 * Who owns this Mac, by the account's own name, so every install's bots know
 * their own owner rather than a name written into the prompt.
 */
let cached: string | undefined;

export function ownerContext(): string {
  // The account name doesn't change while the service runs. Only a name read
  // from the account is kept: a fallback from a slow directory at login is
  // tried again next turn.
  cached ??= accountFullName() ?? undefined;
  const name = cached ?? ownerName();
  return [
    "# Your owner",
    "",
    `Your owner is ${name}, the person signed in to this Mac. "The owner" in these instructions means them. Call them by their first name when it reads naturally.`,
  ].join("\n");
}

export default defineDynamic({
  events: {
    "turn.started": () => {
      try {
        return defineInstructions({ content: ownerContext() });
      } catch (error) {
        // Naming the owner is a courtesy; it must never fail a turn.
        console.error("[instructions] owner context unavailable", error);
        return null;
      }
    },
  },
});
