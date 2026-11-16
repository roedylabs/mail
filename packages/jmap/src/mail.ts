/**
 * Types for JMAP Mail (RFC 8621): Mailbox, Thread, Email, SearchSnippet,
 * Identity, EmailSubmission and VacationResponse with the arguments of their
 * methods that differ from the core.
 */

import type { Comparator, Filter, GetArgs, Id, JmapDate, PatchObject, SetError, UTCDate } from './core.ts';

/** Rights on the mailbox (RFC 8621, 2). */
export interface MailboxRights {
  mayReadItems: boolean;
  mayAddItems: boolean;
  mayRemoveItems: boolean;
  maySetSeen: boolean;
  maySetKeywords: boolean;
  mayCreateChild: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  maySubmit: boolean;
}

/** Mailbox (RFC 8621, 2); `role` per the IANA registry, e.g. `inbox`, `sent`, `trash`. */
export interface Mailbox {
  id: Id;
  name: string;
  parentId: Id | null;
  role: string | null;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
  myRights: MailboxRights;
  isSubscribed: boolean;
}

export interface MailboxFilter {
  parentId?: Id | null;
  name?: string;
  role?: string | null;
  hasAnyRole?: boolean;
  isSubscribed?: boolean;
}

export type MailboxSortProperty = 'sortOrder' | 'name';

/** `Mailbox/query` (RFC 8621, 2.3). */
export interface MailboxQueryExtra {
  sortAsTree?: boolean;
  filterAsTree?: boolean;
}

/** `Mailbox/set` (RFC 8621, 2.5). */
export interface MailboxSetExtra {
  onDestroyRemoveEmails?: boolean;
}

/** `Mailbox/changes`: only counters changed → the list of these properties (RFC 8621, 2.2). */
export interface MailboxChangesExtra {
  updatedProperties: Extract<keyof Mailbox, string>[] | null;
}

/** Thread (RFC 8621, 3): ids of its emails, sorted by `receivedAt`. */
export interface Thread {
  id: Id;
  emailIds: Id[];
}

export interface EmailAddress {
  name: string | null;
  email: string;
}

export interface EmailAddressGroup {
  name: string | null;
  addresses: EmailAddress[];
}

/** Raw header field (RFC 8621, 4.1.2). */
export interface EmailHeader {
  name: string;
  value: string;
}

/** MIME part (RFC 8621, 4.1.4). */
export interface EmailBodyPart {
  partId: string | null;
  blobId: Id | null;
  size: number;
  headers: EmailHeader[];
  name: string | null;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
  language: string[] | null;
  location: string | null;
  subParts: EmailBodyPart[] | null;
}

/** Decoded content of a part (RFC 8621, 4.1.4). */
export interface EmailBodyValue {
  value: string;
  isEncodingProblem: boolean;
  isTruncated: boolean;
}

/**
 * Email (RFC 8621, 4.1). Keywords such as `$seen`, `$flagged`, `$draft`,
 * `$answered` as a set (`{ "$seen": true }`), mailboxes likewise.
 * Further headers via `header:<Name>[:as<Form>][:all]`.
 */
export interface Email {
  id: Id;
  blobId: Id;
  threadId: Id;
  mailboxIds: Record<Id, true>;
  keywords: Record<string, true>;
  size: number;
  receivedAt: UTCDate;
  headers: EmailHeader[];
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  sender: EmailAddress[] | null;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  cc: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  replyTo: EmailAddress[] | null;
  subject: string | null;
  sentAt: JmapDate | null;
  bodyStructure: EmailBodyPart;
  bodyValues: Record<string, EmailBodyValue>;
  textBody: EmailBodyPart[];
  htmlBody: EmailBodyPart[];
  attachments: EmailBodyPart[];
  hasAttachment: boolean;
  preview: string;
  [header: `header:${string}`]: unknown;
}

/** `Email/get` (RFC 8621, 4.2). */
export interface EmailGetExtra {
  bodyProperties?: Extract<keyof EmailBodyPart, string>[];
  fetchTextBodyValues?: boolean;
  fetchHTMLBodyValues?: boolean;
  fetchAllBodyValues?: boolean;
  maxBodyValueBytes?: number;
}

export type EmailGetArgs = GetArgs<Email> & EmailGetExtra;

/** Condition for `Email/query` (RFC 8621, 4.4.1). */
export interface EmailFilter {
  inMailbox?: Id;
  inMailboxOtherThan?: Id[];
  before?: UTCDate;
  after?: UTCDate;
  minSize?: number;
  maxSize?: number;
  allInThreadHaveKeyword?: string;
  someInThreadHaveKeyword?: string;
  noneInThreadHaveKeyword?: string;
  hasKeyword?: string;
  notKeyword?: string;
  hasAttachment?: boolean;
  text?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  /** Name and optionally value of a header. */
  header?: [name: string] | [name: string, value: string];
}

export type EmailSortProperty =
  | 'receivedAt'
  | 'size'
  | 'from'
  | 'to'
  | 'subject'
  | 'sentAt'
  | 'hasKeyword'
  | 'allInThreadHaveKeyword'
  | 'someInThreadHaveKeyword';

export type EmailComparator = Comparator<EmailSortProperty>;

/** `Email/query` and `Email/queryChanges` (RFC 8621, 4.4, 4.5). */
export interface EmailQueryExtra {
  collapseThreads?: boolean;
}

/** `Email/import` (RFC 8621, 4.8). */
export interface EmailImport {
  blobId: Id;
  mailboxIds: Record<Id, true>;
  keywords?: Record<string, true>;
  receivedAt?: UTCDate;
}

export interface EmailImportArgs {
  accountId: Id;
  ifInState?: string | null;
  emails: Record<Id, EmailImport>;
}

export interface EmailImportResponse {
  accountId: Id;
  oldState: string | null;
  newState: string;
  created: Record<Id, Pick<Email, 'id' | 'blobId' | 'threadId' | 'size'>> | null;
  notCreated: Record<Id, SetError> | null;
}

/** `Email/parse` (RFC 8621, 4.9): read an attached message (`message/rfc822`). */
export interface EmailParseArgs extends EmailGetExtra {
  accountId: Id;
  /** Required, except with back-reference `#blobIds`. */
  blobIds?: Id[];
  properties?: Extract<keyof Email, string>[];
}

export interface EmailParseResponse {
  accountId: Id;
  parsed: Record<Id, Email> | null;
  notParsable: Id[] | null;
  notFound: Id[] | null;
}

/** Search hit with highlighted passages (`<mark>`, RFC 8621, 5). */
export interface SearchSnippet {
  emailId: Id;
  subject: string | null;
  preview: string | null;
}

export interface SearchSnippetGetArgs {
  accountId: Id;
  filter?: Filter<EmailFilter> | null;
  /** Required, except with back-reference `#emailIds` (usually to `Email/query` › `/ids`). */
  emailIds?: Id[];
}

export interface SearchSnippetGetResponse {
  accountId: Id;
  list: SearchSnippet[];
  notFound: Id[] | null;
}

/** Sender identity (RFC 8621, 6). */
export interface Identity {
  id: Id;
  name: string;
  email: string;
  replyTo: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
}

/**
 * Vacation response (RFC 8621, 8): exactly one object per account with the id
 * `singleton`; `VacationResponse/set` only updates this one (create and destroy
 * fail with `singleton`).
 */
export interface VacationResponse {
  id: Id;
  isEnabled: boolean;
  /** Reply only to messages from this point in time on; `null` without a start. */
  fromDate: UTCDate | null;
  /** Reply only to messages before this point in time; `null` without an end. */
  toDate: UTCDate | null;
  /** `null`: the server chooses a subject. */
  subject: string | null;
  textBody: string | null;
  /** `null`: the server may generate the HTML part from `textBody`. */
  htmlBody: string | null;
}

/** Address in the SMTP envelope with parameters of `MAIL FROM` or `RCPT TO` (RFC 8621, 7). */
export interface SubmissionAddress {
  email: string;
  /** Parameters per RFC 5321, e.g. `HOLDFOR` (RFC 4865) as a string; `null` without a value. */
  parameters: Record<string, string | null> | null;
}

/** SMTP envelope of a submission (RFC 8621, 7). */
export interface Envelope {
  mailFrom: SubmissionAddress;
  rcptTo: SubmissionAddress[];
}

/** Delivery to one recipient (RFC 8621, 7: `deliveryStatus`). */
export interface DeliveryStatus {
  smtpReply: string;
  delivered: 'queued' | 'yes' | 'no' | 'unknown';
  displayed: 'unknown' | 'yes';
}

/** Submission of an email for sending (RFC 8621, 7). */
export interface EmailSubmission {
  id: Id;
  identityId: Id;
  emailId: Id;
  threadId: Id;
  /** `null`: the server builds the envelope from the headers. */
  envelope: Envelope | null;
  sendAt: UTCDate;
  /** `pending` as long as it can still be withdrawn (`canceled`). */
  undoStatus: 'pending' | 'final' | 'canceled';
  deliveryStatus: Record<string, DeliveryStatus> | null;
  dsnBlobIds: Id[];
  mdnBlobIds: Id[];
}

/** Condition of `EmailSubmission/query` (RFC 8621, 7.3). */
export interface EmailSubmissionFilter {
  identityIds?: Id[];
  emailIds?: Id[];
  threadIds?: Id[];
  undoStatus?: EmailSubmission['undoStatus'];
  before?: UTCDate;
  after?: UTCDate;
}

export type EmailSubmissionSortProperty = 'emailId' | 'threadId' | 'sentAt';

/**
 * `EmailSubmission/set` (RFC 8621, 7.5): after a successful create, update
 * or destroy, the server updates or destroys the associated email; keys are
 * ids of the submission or `#<creation id>`. The response to that appears as
 * an implicit `Email/set` under the same call id.
 */
export interface EmailSubmissionSetExtra {
  onSuccessUpdateEmail?: Record<string, PatchObject> | null;
  onSuccessDestroyEmail?: string[] | null;
}
