import { ClientConnect, __ws__ } from './client.connect';
import { fallback } from '../utils/fallback';
import { justinfan } from '../utils/justinfan';
import { ParsedMessage, parseMessage } from '../parser/message';
import { SplitMessage } from './client.handle-message';
import { Observable } from 'rxjs/Observable';
import { Subject } from 'rxjs/Subject';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/do';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/switchMap';
import 'rxjs/add/observable/from';
import { HandleNoPrefixMessage } from './handlers/no-prefix';
import { HandleTmiMessage } from './handlers/tmi-messages';
import { handleJtvMessages } from './handlers/jtv-messages';
import { handleOtherMessages } from './handlers/other-messages';
import { setChannels, setLoggingLevel, setOptions, setRateLimit } from '../state/core/core.actions';
import { closeConnection } from '../state/connection/connection.actions';
import { CannotCloseWS } from '../utils/errors';
import { ClientEventMap } from './event-types';
import { logger, LoggingLevels } from '../logger';
import { __sendCommand } from './client.send-command';
import { ClientInterface } from './client.interface';
import { messageQueue } from './message-queue';
import { store } from './store';

export const messageQueue$ = messageQueue(store);

export let __event$__;

export function Client(opts: ClientOptions): ClientInterface {

  const moderatorStatus = {};

  logger.setLoggingLevel(fallback(opts.loggingLevel, 'info'));

  opts.connection = fallback(opts.connection, {});
  opts.identity = fallback(opts.identity, {});

  const message$ = new Subject<string>();
  __event$__ = new Subject<any>();

  const options = {
    connection: {
      server: fallback(opts.connection.server, 'irc-ws.chat.twitch.tv'),
      port: fallback(opts.connection.port, opts.connection.secure ? 443 : 80),
      reconnect: fallback(opts.connection.reconnect, false),
      maxReconnectAttempts: fallback(opts.connection.maxReconnectAttempts, Infinity),
      maxReconnectInterval: fallback(opts.connection.maxReconnectInterval, 30000),
      reconnectDecay: fallback(opts.connection.reconnectDecay, 1.5),
      reconnectInterval: fallback(opts.connection.reconnectInterval, 1000),
      secure: fallback(opts.connection.secure, false),
      timeout: fallback(opts.connection.timeout, 9999)
    },
    identity: {
      username: fallback(opts.identity.username, justinfan()),
      password: fallback(opts.identity.password, 'oauth:layerone')
    },
    channels: fallback(opts.channels, []),
    options: fallback(opts.options, {})
  } as ClientOptions;

  store.dispatch('core', setOptions(Object.assign({}, opts, options)));

  // Override Logger if set
  if (opts.logger) {
    for (const fn in opts.logger) {
      if (opts.logger.hasOwnProperty(fn)) {
        logger[fn] = opts.logger[fn];
      }
    }
  }
  messageQueue$
    .messages
    .subscribe((message: string) => {
      if (__ws__ !== null && __ws__.readyState !== 2 && __ws__.readyState !== 3) {
        logger.debug(`[Message Queue] Sending: ${message}`);
        __ws__.send(message);
      } else {
        // Websocket isn't currently connected, requeue our message
        logger.debug(`[Message Queue] Requeue: ${message}`);
        messageQueue$.addMessage(message);
      }
    });


  message$
    .do(logger.trace)
    .switchMap((message) => Observable.from(SplitMessage(message)))
    .map(parseMessage)
    .do((message: ParsedMessage) => {
      if (message.prefix === null) {
        HandleNoPrefixMessage(message, __event$__);
      } else if (message.prefix === "tmi.twitch.tv") {
        HandleTmiMessage(message, __event$__);
      } else if (message.prefix === "jtv") {
        handleJtvMessages(message, __event$__);
      } else {
        handleOtherMessages(message, __event$__);
      }
    })
    .subscribe((message) => {
      // logger.info(message);
    });

  const disconnect = async (): Promise<void> => {
    if (__ws__ !== null && __ws__.readyState !== 3) {
      store.dispatch('connection', closeConnection(true));
      logger.info('Disconnecting From Server');
      __ws__.close();
    } else {
      logger.error(CannotCloseWS);
      throw new Error(CannotCloseWS);
    }
  };

  const reconnect = (timer = store.get('connection').reconnectTimer) => {
    disconnect();
    setTimeout(() => {
      ClientConnect(options, message$, __event$__);
    }, timer);
  };

  __event$__
    .filter(event => event.type === '_RECONNECT_')
    .do(() => reconnect())
    .subscribe();

  __event$__
    .filter(event => event.type === 'join' || event.type === 'mod' || event.type === 'unmod')
    .subscribe(event => {
      if (event.type === 'join' && event.self && event.userstate) {
        moderatorStatus[event.channel] = event.userstate.mod;
      } else if (event.type === 'mod' && event.username === store.get('core').username) {
        moderatorStatus[event.channel] = true;
      } else if (event.type === 'unmod' && event.username === store.get('core').username) {
        moderatorStatus[event.channel] = false;
      }

      let isModInAll = true;
      for (const channel in moderatorStatus) {
        if (moderatorStatus.hasOwnProperty(channel)) {
          if (!moderatorStatus[channel]) {
            logger.warn(`Not moderated in channel ${channel}`);
            isModInAll = false;
            break;
          }
        }
      }
      logger.debug(`[Rate Limit] Setting Rate limit to ${isModInAll ? (30 / 100) * 1000 : (30 / 20) * 1000}`);
      store.dispatch('core', setRateLimit(isModInAll ? (30 / 100) * 1000 : (30 / 20) * 1000));
    });


  // Our exposed API
  return {
    connect: ClientConnect(options, message$, __event$__),

    disconnect: disconnect,

    on: <MessageType extends keyof ClientEventMap>(type: MessageType):
      Observable<ClientEventMap[MessageType] & { type: MessageType; raw: ParsedMessage; }> =>
      __event$__.filter(event => event.type === type),

    __sendCommand: __sendCommand
  };
}

export interface ClientOptions {
  options?: {
    clientId: string;
    debug: boolean;
  };
  connection?: {
    server?: string;
    port?: number;
    reconnect?: boolean;
    maxReconnectAttempts?: number;
    maxReconnectInterval?: number;
    reconnectDecay?: number;
    reconnectInterval?: number;
    secure?: boolean;
    timeout?: number;
  };
  identity?: {
    username?: string;
    password?: string;
  };
  channels: string[];
  loggingLevel?: LoggingLevels;
  logger?: {
    trace?: () => void;
    debug?: () => void;
    info?: () => void;
    warn?: () => void;
    error?: () => void;
    fatal?: () => void;
  };
}
