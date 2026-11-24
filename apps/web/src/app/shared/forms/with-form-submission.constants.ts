import type { FormSubmissionState } from './forms.model';

export const NO_SUBMISSION: FormSubmissionState<never> = {
  submitting: false,
  submittedValue: null,
  serverErrors: [],
  saves: 0,
};
