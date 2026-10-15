import type { OpenPersModule } from '../lib/context';
import { orgModule } from './org';
import { peopleModule } from './people';
import { absenceModule } from './absence';
import { timeModule } from './time';
import { documentsModule } from './documents';
import { recruitingModule } from './recruiting';
import { workflowModule } from './workflow';
import { analyticsModule } from './analytics';
import { performanceModule } from './performance';
import { surveysModule } from './surveys';

/** Feature modules in registration order. Core is registered separately by the app. */
export function featureModules(): OpenPersModule[] {
  return [orgModule, peopleModule, absenceModule, timeModule, documentsModule, recruitingModule, workflowModule, analyticsModule, performanceModule, surveysModule];
}
