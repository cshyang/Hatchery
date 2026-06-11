-- Image avatars for personas: chat.postMessage icon_url (public https image, e.g. a
-- DiceBear PNG seeded with the persona name). Slack prefers icon_emoji when both are
-- sent, so the post layer sends exactly one; set_persona replaces both icon fields on
-- every call to avoid stale combinations.
ALTER TABLE personas ADD COLUMN icon_url TEXT;
