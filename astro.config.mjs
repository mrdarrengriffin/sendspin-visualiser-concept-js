// @ts-check
import { defineConfig } from 'astro/config';

// Static site. Serve it over plain http:// when hosting: the Sendspin endpoint is ws:// and
// browsers block that from an https:// page (see docs/sendspin-integration).
export default defineConfig({
  site: 'http://sendspin-visualiser.local',
  output: 'static',
  trailingSlash: 'ignore',
});
