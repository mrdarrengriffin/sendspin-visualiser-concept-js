// Type surface of the patched @sendspin/sendspin-js bundle in ./vendor (built from tools/).
declare module './vendor/sendspin.js' {
  import type { SendspinPlayer, SendspinPlayerConfig } from './client';
  export const SendspinPlayer: new (config: SendspinPlayerConfig) => SendspinPlayer;
}
