import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ComponentType, type Message } from 'discord.js';
import { uploadedArtworkUrl } from '../src/artwork.js';

test('V2 gallery uploads are retained even when the legacy attachments list is empty', () => {
  const url = 'https://cdn.discordapp.com/attachments/channel/file/player-a.png';
  const message = { attachments: new Collection(), components: [{ type: ComponentType.Container, components: [
    { type: ComponentType.MediaGallery, items: [{ media: { url } }] },
  ] }] } as unknown as Message;
  assert.equal(uploadedArtworkUrl(message, 'player-a.png'), url);
  assert.equal(uploadedArtworkUrl(message, 'player-b.png'), undefined);
  assert.equal(uploadedArtworkUrl(undefined, 'player-a.png'), undefined);
});
