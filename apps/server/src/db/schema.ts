import * as core from '../modules/core/schema';
import * as org from '../modules/org/schema';
import * as people from '../modules/people/schema';
import * as absence from '../modules/absence/schema';
import * as time from '../modules/time/schema';
import * as docs from '../modules/documents/schema';

export const schema = { ...core, ...org, ...people, ...absence, ...time, ...docs };
export * from '../modules/core/schema';
export * from '../modules/org/schema';
export * from '../modules/people/schema';
export * from '../modules/absence/schema';
export * from '../modules/time/schema';
export * from '../modules/documents/schema';
