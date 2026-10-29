// Initiative commits (spec B §4): `docs(initiative): <subject>` + the configured trailer.
export const initiativeCommitMessage = (subject: string, trailer: string): string =>
  `docs(initiative): ${subject.replace(/\s+/g, ' ').trim()}\n${trailer ? `\n${trailer}\n` : ''}`
