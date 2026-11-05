import { HttpParams, type HttpInterceptorFn } from '@angular/common/http';
import { STRICT_QUERY_CODEC } from './strict-query.constants';

/** Every request's query escaped whole (STRICT_QUERY_CODEC), whoever built its params. */
export const strictQueryInterceptor: HttpInterceptorFn = (request, next) => {
  if (request.params.keys().length === 0) return next(request);
  let params = new HttpParams({ encoder: STRICT_QUERY_CODEC });
  for (const key of request.params.keys()) {
    for (const value of request.params.getAll(key) ?? []) params = params.append(key, value);
  }
  return next(request.clone({ params }));
};
