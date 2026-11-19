-- Migration 0003: language of the last sign-in.
--
-- From the browser's `Accept-Language` at each sign-in (`de` for German,
-- `en` for every other language). Backend texts and emails use it for people
-- whose language setting is `system`; without one, English. Existing rows
-- start without one and get it at their next sign-in.
ALTER TABLE users ADD COLUMN sign_in_lang TEXT CHECK (sign_in_lang IN ('de', 'en'));
