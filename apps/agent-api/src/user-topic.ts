// The stable pinned topic seeded by Google onboarding. The name never changes;
// the user's actual name is a fact recorded in the body (see
// docs/onboarding.md). Both UserDO (which seeds it) and the agent prompts
// (which tell every writer what belongs in it) name the same topic, so the
// constants live in this leaf module rather than in either.
export const USER_TOPIC = "User";

// Routing blurb shown by list_topics. It states the scope, because a
// description promising "durable facts about the user" is what invited the
// topic to grow into a second knowledge document.
export const USER_TOPIC_DESCRIPTION =
  "Who the user is: name, how to address them, where they live, work, languages, closest people. Identity only: addresses, documents, plans and anything ongoing live in their own topics, linked from here.";
