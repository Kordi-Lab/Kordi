import type { CloudArtifactActivity, CloudTaskActivity } from './authClient';
import type { CloudSessionActivityStore } from './cloudSessionActivity';

function stringArraysEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function taskActivitiesEqual(left: CloudTaskActivity, right: CloudTaskActivity) {
  return left.taskActivityId === right.taskActivityId
    && left.sessionId === right.sessionId
    && left.taskId === right.taskId
    && left.title === right.title
    && left.summary === right.summary
    && left.status === right.status
    && left.createdByAccountId === right.createdByAccountId
    && left.targetAccountId === right.targetAccountId
    && JSON.stringify(left.participants) === JSON.stringify(right.participants)
    && stringArraysEqual(left.artifactIds, right.artifactIds)
    && left.responseMessageId === right.responseMessageId
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && left.archivedAt === right.archivedAt;
}

function artifactActivitiesEqual(left: CloudArtifactActivity, right: CloudArtifactActivity) {
  return left.artifactActivityId === right.artifactActivityId
    && left.sessionId === right.sessionId
    && left.artifactId === right.artifactId
    && left.name === right.name
    && left.path === right.path
    && left.kind === right.kind
    && left.category === right.category
    && left.summary === right.summary
    && left.createdByAccountId === right.createdByAccountId
    && left.sourceMessageId === right.sourceMessageId
    && left.attachmentId === right.attachmentId
    && left.contentType === right.contentType
    && left.sizeBytes === right.sizeBytes
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && left.archivedAt === right.archivedAt;
}

function activityRowsEqual<T>(
  left: Readonly<Record<string, readonly T[]>>,
  right: Readonly<Record<string, readonly T[]>>,
  rowsEqual: (leftRow: T, rightRow: T) => boolean,
) {
  const leftEntries = Object.entries(left);
  const rightKeys = Object.keys(right);
  return leftEntries.length === rightKeys.length
    && leftEntries.every(([sessionId, leftRows]) => {
      const rightRows = right[sessionId];
      return Boolean(rightRows)
        && leftRows.length === rightRows.length
        && leftRows.every((row, index) => rowsEqual(row, rightRows[index]));
    });
}

export function cloudSessionActivityEqual(
  left: CloudSessionActivityStore,
  right: CloudSessionActivityStore,
) {
  return Object.is(left, right)
    || (
      activityRowsEqual(left.tasksBySessionId, right.tasksBySessionId, taskActivitiesEqual)
      && activityRowsEqual(
        left.artifactsBySessionId,
        right.artifactsBySessionId,
        artifactActivitiesEqual,
      )
    );
}
