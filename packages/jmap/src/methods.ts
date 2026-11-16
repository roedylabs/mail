/**
 * Methods with their arguments and responses. Further methods (Quota)
 * extend `Methods` via declaration merging:
 *
 * ```ts
 * declare module '@roedy/jmap' {
 *   interface Methods {
 *     'Quota/get': { args: GetArgs<Quota>; response: GetResponse<Quota> };
 *   }
 * }
 * ```
 */

import {
  BLOB,
  CONTACTS,
  CORE,
  MAIL,
  QUOTA,
  SIEVE,
  SUBMISSION,
  VACATION,
  type ChangesArgs,
  type ChangesResponse,
  type CopyArgs,
  type CopyResponse,
  type GetArgs,
  type GetResponse,
  type QueryArgs,
  type QueryChangesArgs,
  type QueryChangesResponse,
  type QueryResponse,
  type SetArgs,
  type SetResponse,
} from './core.ts';
import type { ContactCard, ContactCardFilter, ContactCardSortProperty } from './contacts.ts';
import type {
  PushSubscriptionGetArgs,
  PushSubscriptionGetResponse,
  PushSubscriptionSetArgs,
  PushSubscriptionSetResponse,
} from './push.ts';
import type { SieveScript, SieveScriptSetArgs, SieveScriptValidateArgs, SieveScriptValidateResponse } from './sieve.ts';
import type {
  Email,
  EmailFilter,
  EmailGetArgs,
  EmailImportArgs,
  EmailImportResponse,
  EmailParseArgs,
  EmailParseResponse,
  EmailQueryExtra,
  EmailSortProperty,
  EmailSubmission,
  EmailSubmissionFilter,
  EmailSubmissionSetExtra,
  EmailSubmissionSortProperty,
  Identity,
  Mailbox,
  MailboxChangesExtra,
  MailboxFilter,
  MailboxQueryExtra,
  MailboxSetExtra,
  MailboxSortProperty,
  SearchSnippetGetArgs,
  SearchSnippetGetResponse,
  Thread,
  VacationResponse,
} from './mail.ts';

interface Method<A, R> {
  args: A;
  response: R;
}

export interface Methods {
  'Core/echo': Method<Record<string, unknown>, Record<string, unknown>>;

  'Mailbox/get': Method<GetArgs<Mailbox>, GetResponse<Mailbox>>;
  'Mailbox/changes': Method<ChangesArgs, ChangesResponse & MailboxChangesExtra>;
  'Mailbox/query': Method<QueryArgs<MailboxFilter, MailboxSortProperty> & MailboxQueryExtra, QueryResponse>;
  'Mailbox/queryChanges': Method<QueryChangesArgs<MailboxFilter, MailboxSortProperty>, QueryChangesResponse>;
  'Mailbox/set': Method<SetArgs<Mailbox> & MailboxSetExtra, SetResponse<Mailbox>>;

  'Thread/get': Method<GetArgs<Thread>, GetResponse<Thread>>;
  'Thread/changes': Method<ChangesArgs, ChangesResponse>;

  'Email/get': Method<EmailGetArgs, GetResponse<Email>>;
  'Email/changes': Method<ChangesArgs, ChangesResponse>;
  'Email/query': Method<QueryArgs<EmailFilter, EmailSortProperty> & EmailQueryExtra, QueryResponse>;
  'Email/queryChanges': Method<
    QueryChangesArgs<EmailFilter, EmailSortProperty> & EmailQueryExtra,
    QueryChangesResponse
  >;
  'Email/set': Method<SetArgs<Email>, SetResponse<Email>>;
  'Email/copy': Method<CopyArgs<Email>, CopyResponse<Email>>;
  'Email/import': Method<EmailImportArgs, EmailImportResponse>;
  'Email/parse': Method<EmailParseArgs, EmailParseResponse>;

  'SearchSnippet/get': Method<SearchSnippetGetArgs, SearchSnippetGetResponse>;

  'PushSubscription/get': Method<PushSubscriptionGetArgs, PushSubscriptionGetResponse>;
  'PushSubscription/set': Method<PushSubscriptionSetArgs, PushSubscriptionSetResponse>;

  'Identity/get': Method<GetArgs<Identity>, GetResponse<Identity>>;
  'Identity/changes': Method<ChangesArgs, ChangesResponse>;
  'Identity/set': Method<SetArgs<Identity>, SetResponse<Identity>>;
  'EmailSubmission/get': Method<GetArgs<EmailSubmission>, GetResponse<EmailSubmission>>;
  'EmailSubmission/changes': Method<ChangesArgs, ChangesResponse>;
  'EmailSubmission/query': Method<QueryArgs<EmailSubmissionFilter, EmailSubmissionSortProperty>, QueryResponse>;
  'EmailSubmission/queryChanges': Method<
    QueryChangesArgs<EmailSubmissionFilter, EmailSubmissionSortProperty>,
    QueryChangesResponse
  >;
  'EmailSubmission/set': Method<SetArgs<EmailSubmission> & EmailSubmissionSetExtra, SetResponse<EmailSubmission>>;

  'VacationResponse/get': Method<GetArgs<VacationResponse>, GetResponse<VacationResponse>>;
  'VacationResponse/set': Method<SetArgs<VacationResponse>, SetResponse<VacationResponse>>;

  'SieveScript/get': Method<GetArgs<SieveScript>, GetResponse<SieveScript>>;
  'SieveScript/set': Method<SieveScriptSetArgs, SetResponse<SieveScript>>;
  'SieveScript/validate': Method<SieveScriptValidateArgs, SieveScriptValidateResponse>;

  'ContactCard/get': Method<GetArgs<ContactCard>, GetResponse<ContactCard>>;
  'ContactCard/query': Method<QueryArgs<ContactCardFilter, ContactCardSortProperty>, QueryResponse>;
}

export type MethodName = Extract<keyof Methods, string>;
export type ArgsOf<M extends MethodName> = Methods[M]['args'];
export type ResponseOf<M extends MethodName> = Methods[M]['response'];

/** Capability per data type (part before the `/`), for the request's `using`. */
const CAPABILITY_OF_TYPE: Readonly<Record<string, string>> = {
  Core: CORE,
  Blob: BLOB,
  PushSubscription: CORE,
  Mailbox: MAIL,
  Thread: MAIL,
  Email: MAIL,
  SearchSnippet: MAIL,
  Identity: SUBMISSION,
  EmailSubmission: SUBMISSION,
  VacationResponse: VACATION,
  Quota: QUOTA,
  SieveScript: SIEVE,
  ContactCard: CONTACTS,
};

/** Capability a method needs in `using`, or `undefined` for unknown data types. */
export function capabilityOf(method: string): string | undefined {
  // `Blob/copy` belongs to core, the other Blob methods to RFC 9404.
  if (method === 'Blob/copy') return CORE;
  const type = method.slice(0, method.indexOf('/'));
  return Object.hasOwn(CAPABILITY_OF_TYPE, type) ? CAPABILITY_OF_TYPE[type] : undefined;
}
