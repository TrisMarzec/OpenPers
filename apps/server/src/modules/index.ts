import type { OpenPersModule } from '../lib/context';
import { orgModule } from './org';
import { peopleModule } from './people';
import { absenceModule } from './absence';
import { timeModule } from './time';
import { documentsModule } from './documents';
import { recruitingModule } from './recruiting';

/** Feature modules in registration order. Core is registered separately by the app. */
export function featureModules(): OpenPersModule[] {
  return [orgModule, peopleModule, absenceModule, timeModule, documentsModule, recruitingModule];
}
