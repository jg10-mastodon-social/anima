import Elysia from 'elysia';

import Auth from '../../../services/Auth';
import chats from './chats';
import evals from './evals';
import models from './models';
import providers from './providers';

export default new Elysia().group('ai', { beforeHandle: ({ request }) => Auth.assertLoggedIn(request) }, (app) =>
  app.use(providers).use(models).use(chats).use(evals),
);
