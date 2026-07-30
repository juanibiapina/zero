// The learning port: everything a learning job needs from the user's data,
// behind one interface.
//
// It exists because a Durable Object cannot read another Durable Object's
// SQLite. LearningDO runs the learner and reaches UserDO's data through this
// port, so the learner never knows whether it is talking to a local store or to
// an RPC stub. Two adapters implement it: `createStoreLearningPort` (a local
// Store, used by tests) and `createRemoteLearningPort` (a UserDO stub).
//
// Every method is async, and topic writes carry `expectedVersion` exactly as the
// interactive tools do. There is deliberately no unchecked write path here: a
// learner that could skip the version check would be able to clobber a
// conversation's knowledge mid-turn.

import type { LearningMessage, TopicToolStore } from "../store/types";

export interface LearningPort {
  // Versioned topic reads and writes, the same surface the interactive tools
  // use, so the learner runs the same tool module.
  topics: TopicToolStore;
  // Start (or re-attach to) a job, returning the newest message id it covers.
  // Frozen: messages that arrive later belong to the next job.
  beginJob(jobId: string): Promise<number>;
  // Raw unconsolidated messages in id order, up to the job's mark.
  listMessages(input: {
    throughMessageId: number;
    afterId?: number;
    limit: number;
  }): Promise<LearningMessage[]>;
  // Stamp the job's range consolidated. Idempotent by job id, and it never
  // changes the knowledge version: the topic writes already did that.
  completeJob(jobId: string): Promise<void>;
  // Move one conversation's compaction boundary and store its summary. Deletes
  // nothing: the raw log is what learning reads.
  compactConversation(
    conversationId: string,
    input: { throughMessageId: number; summary: string },
  ): Promise<void>;
}

// A topic write as it crosses an RPC boundary. A thrown KnowledgeConflictError
// would arrive as a plain Error and lose which versions collided, so the result
// is data and the remote adapter rebuilds the error on the far side.
export type TopicWriteResult =
  | { version: number }
  | { conflict: { expected: number; current: number } }
  | { failed: string };
