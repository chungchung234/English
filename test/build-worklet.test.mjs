import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveBuildSiteUrl} from '../scripts/bundle-web.mjs';

test('hosting origin is explicit, secure and canonical across custom, project and user Pages sites',()=>{
 assert.equal(resolveBuildSiteUrl({BUILD_SITE_URL:'https://custom.example/English'}),'https://custom.example/English/');
 assert.equal(resolveBuildSiteUrl({GITHUB_REPOSITORY:'Owner/English'}),'https://owner.github.io/English/');
 assert.equal(resolveBuildSiteUrl({GITHUB_REPOSITORY:'Owner/Owner.github.io'}),'https://owner.github.io/');
 assert.equal(resolveBuildSiteUrl({BUILD_SITE_URL:'http://127.0.0.1:4173/built/',GITHUB_REPOSITORY:'invalid'}),'http://127.0.0.1:4173/built/');
 for(const BUILD_SITE_URL of ['javascript:alert(1)','data:text/javascript,1','/relative/','http://public.example/','https://user:password@example.com/','https://example.com/?query=1','https://example.com/#fragment','https://example.com/?','https://example.com/#',"https://example.com/'unsafe-eval'/",'https://example.com/;script-src/'])assert.throws(()=>resolveBuildSiteUrl({BUILD_SITE_URL}));
 assert.throws(()=>resolveBuildSiteUrl({}),/BUILD_SITE_URL/);
 for(const GITHUB_REPOSITORY of ['owner','owner/repository/extra','owner/..','owner name/repository'])assert.throws(()=>resolveBuildSiteUrl({GITHUB_REPOSITORY}));
});
