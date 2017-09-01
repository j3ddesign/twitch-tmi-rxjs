import { Subject } from 'rxjs/Subject';
import { Observable } from 'rxjs/Observable';
import 'rxjs/add/observable/of';
import 'rxjs/add/operator/concatMap';
import 'rxjs/add/operator/delay';
import { store } from './client';

export const _messageQueue$ = new Subject<string>();

export const messageQueue = () => ({
  addMessage: (message: string) => _messageQueue$.next(message),
  messages: _messageQueue$.concatMap((message: string) =>
    Observable
      .of(message)
      .delay(store.get('core').rateLimit)
  )
});


