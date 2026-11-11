import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDay, reviewGroupLabel } from '../web/review-journal.js';
test('review groups calls by their saved local start date and labels dates without relative-day duplication',()=>{
 const session={created_at:'2026-11-10T15:01:00Z',time_zone:'Asia/Seoul',analysis_created_at:'2026-11-12T10:00:00Z'};
 assert.equal(reviewDay(session),'2026-11-11');
 assert.equal(reviewDay({...session,time_zone:'America/Los_Angeles'}),'2026-11-10');
 assert.equal(reviewDay({...session,time_zone:null},'UTC'),'2026-11-10');
 assert.equal(reviewGroupLabel(reviewDay(session),'2026'),'11월 11일');
 assert.equal(reviewGroupLabel('2025-12-31','2026'),'2025년 12월 31일','older-year groups keep their year while browsing a newer month');
});
