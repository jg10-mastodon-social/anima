import { auth } from '@anima/core';
import { isTruthy } from '@noeldemartin/utils';
import { tool } from 'ai';
import { TypeIndex } from 'soukai-bis';
import z from 'zod';

const TypesIndexSchema = z.array(
  z.object({
    dataType: z.string().describe('The type of data being indexed, expressed as an RDF type.'),
    url: z.string().describe('The location of the data being indexed: a container url, or a single document url.'),
    kind: z
      .enum(['container', 'instance'])
      .describe(
        'Whether url is a container (list it with listContainerFiles) or a single resource (read it with readFileContents).',
      ),
  }),
);

export default tool({
  description:
    "Get an index of the user's data, including their locations and types. Each entry is either a container to list or a single resource to read.",
  inputSchema: z.object({}),
  outputSchema: TypesIndexSchema,
  strict: true,
  async execute() {
    const user = auth().getUser();
    const typeIndexes = await Promise.all(
      [
        user.publicTypeIndexUrl && TypeIndex.find(user.publicTypeIndexUrl),
        user.privateTypeIndexUrl && TypeIndex.find(user.privateTypeIndexUrl),
      ].filter(isTruthy),
    );

    const index: z.input<typeof TypesIndexSchema> = [];

    for (const typeIndex of typeIndexes) {
      for (const registration of typeIndex?.registrations ?? []) {
        const instanceContainer = registration.instanceContainer;
        const instance = registration.instance;
        const url = instanceContainer ?? instance;

        if (!url) {
          continue;
        }

        for (const forClass of registration.forClass) {
          index.push({
            dataType: forClass.toString(),
            url,
            kind: instanceContainer ? 'container' : 'instance',
          });
        }
      }
    }

    return index;
  },
});
