import { describe, expect, it } from 'vitest';
import { assertMediaReady, attachmentReady, messageLabel, sameMessage, unresolvedAttachments } from '../shared/media';
import type { ChatMessage, QuestionContext, AttachmentInfo } from '../shared/types';
const photo: ChatMessage = { id: 'photo', text: '', sender: '학생', direction: 'incoming', time: '', attachments: [{ id: 'media-0', kind: 'image' }] };
const context = (message = photo, imageCount = 1): QuestionContext => ({ question: message, references: [], note: '', updatedAt: 1, attachments: [{ id: 'file1', name: '문제.png', kind: 'image', size: 10, imageCount, excerpt: '', source: { message, attachmentId: 'media-0' } }] });
describe('unread chat media policy', () => {
  it('keeps non-text attachments visible and blocks all answer generation until actual linked content is available', () => {
    expect(messageLabel(photo)).toBe('[사진]'); expect(() => assertMediaReady([photo], [])).toThrow('내용 확인');
    expect(() => assertMediaReady([photo], [context()])).not.toThrow();
  });
  it('does not assume an unbound file or an old attachment from the same sender covers a new photo', () => {
    const unbound = context(); delete unbound.attachments[0].source;
    expect(attachmentReady(photo, photo.attachments![0], [unbound])).toBe(false);
    expect(attachmentReady({ ...photo, id: 'new-photo' }, photo.attachments![0], [context()])).toBe(false);
  });
  it('requires visual data for images and enough images for a gallery', () => {
    expect(attachmentReady(photo, photo.attachments![0], [context(photo, 0)])).toBe(false);
    const gallery = { ...photo, attachments: [{ ...photo.attachments![0], count: 3 }] };
    expect(attachmentReady(gallery, gallery.attachments[0], [context(gallery, 1)])).toBe(false);
    expect(attachmentReady(gallery, gallery.attachments[0], [context(gallery, 3)])).toBe(true);
  });
  it('includes selected older question media and reference media, and does not count duplicates twice', () => {
    const linked = context({ ...photo, id: 'text-question', text: '이거 알려주세요', attachments: [] }); linked.references = [photo]; linked.attachments = [];
    expect(unresolvedAttachments([], [linked], [linked.question])).toHaveLength(1);
    expect(unresolvedAttachments([photo], [], [photo])).toHaveLength(1);
  });
  it('rejects stale mappings when an accessibility row is reused or its metadata changes', () => {
    const changed = { ...photo, attachments: [{ ...photo.attachments![0], kind: 'file' as const, name: '다른문제.hwp' }] };
    expect(sameMessage(photo, changed)).toBe(false); expect(attachmentReady(changed, changed.attachments[0], [context()])).toBe(false);
    expect(() => assertMediaReady([changed], [context()])).toThrow();
  });
});

it('does not mistake JSON object-key ordering or a refreshed timestamp for a different attachment', () => {
  const reordered = { ...photo, time: '오후 3:00', attachments: [{ kind: 'image' as const, id: 'media-0' }] };
  expect(sameMessage(photo, reordered)).toBe(true); expect(attachmentReady(reordered, reordered.attachments[0], [context()])).toBe(true);
});
