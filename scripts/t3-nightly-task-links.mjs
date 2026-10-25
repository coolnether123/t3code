import * as NodeURL from "node:url";

export function scopedTaskGit(git, upstreamCommit) {
  if (!/^[a-f0-9]{40}$/.test(upstreamCommit)) throw new Error("Expected pinned upstream commit");
  return (repository, ...args) =>
    git(repository, ...args, ...(args[0] === "rev-list" ? ["--not", upstreamCommit] : []));
}

if (process.argv[1] === import.meta.filename) {
  const [checker, base, upstreamCommit] = process.argv.slice(2);
  const { checkTaskLinks, runGit } = await import(NodeURL.pathToFileURL(checker).href);
  const repository = process.cwd();
  const git = (root, ...args) => runGit(root, args);
  if ((await git(repository, "cat-file", "-t", upstreamCommit)) !== "commit")
    throw new Error("Pinned upstream object is not a commit");
  // Imported upstream history is unchanged third-party work. Every fork commit
  // still passes the normal remote-freshness, trailer, agenda and clean-tree checks.
  const result = await checkTaskLinks({
    repository,
    base,
    gitCommand: scopedTaskGit(git, upstreamCommit),
    readTask: async (id) => {
      const endpoint = new URL(
        `/api/v1/agenda/tasks/${id}`,
        process.env.OTIS_AGENDA_URL ?? "http://127.0.0.1:5197",
      );
      if (
        endpoint.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
        endpoint.username ||
        endpoint.password
      )
        throw new Error("Expected local agenda endpoint");
      const response = await fetch(endpoint, {
        headers: { "X-Otis-Actor": process.env.OTIS_AGENDA_ACTOR ?? "user:local" },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`Agenda HTTP ${response.status}`);
      return response.json();
    },
  });
  console.log(JSON.stringify({ ...result, importedHistory: upstreamCommit }));
  process.exitCode = result.findings.length ? 1 : 0;
}
