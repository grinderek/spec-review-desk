// Initiative commits (spec B §4): `docs(openspec): <subject>` + the configured trailer.
export const initiativeCommitMessage = (subject: string, trailer: string): string =>
  `docs(openspec): ${subject.replace(/\s+/g, ' ').trim()}\n${trailer ? `\n${trailer}\n` : ''}`
