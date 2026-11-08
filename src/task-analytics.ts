import type { NativeUsage } from "./quota-history.ts";
export function taskAnalytics(activity: ReadonlyArray<NativeUsage>) {
  const tasks = new Map<
    string,
    {
      id: string;
      title: string;
      project: string;
      tokens: number;
      value: number;
      unpriced: number;
      turns: number;
    }
  >();
  const projects = new Map<
    string,
    {
      name: string;
      tokens: number;
      value: number;
      unpriced: number;
      tasks: Set<string>;
    }
  >();
  const models = new Map<string, number>();
  let unassigned = 0;
  for (const u of activity) {
    const n = u.group.tokens.total || 0,
      name = u.project || "Unassigned project";
    const project = projects.get(name) || {
      name,
      tokens: 0,
      value: 0,
      unpriced: 0,
      tasks: new Set<string>(),
    };
    project.tokens += n;
    if (u.estimatedUsd != null) project.value += u.estimatedUsd;
    else project.unpriced++;
    projects.set(name, project);
    models.set(u.group.model, (models.get(u.group.model) || 0) + n);
    if (!u.task || u.task.startsWith("native:")) {
      unassigned++;
      continue;
    }
    const task = tasks.get(u.task) || {
      id: u.task,
      title: u.taskTitle || "Conversation " + u.task.slice(0, 8),
      project: name,
      tokens: 0,
      value: 0,
      unpriced: 0,
      turns: 0,
    };
    task.tokens += n;
    task.turns++;
    if (u.estimatedUsd != null) task.value += u.estimatedUsd;
    else task.unpriced++;
    tasks.set(u.task, task);
    project.tasks.add(u.task);
  }
  const values = [...tasks.values()].map((t) => t.tokens).sort((a, b) => a - b),
    count = values.length;
  const mean = count ? values.reduce((a, b) => a + b, 0) / count : 0;
  const variance = count
    ? values.reduce((s, n) => s + (n - mean) ** 2, 0) / count
    : 0;
  return {
    tasks: [...tasks.values()],
    projects: [...projects.values()].map((p) => ({
      ...p,
      tasks: p.tasks.size,
    })),
    models: [...models].map(([name, tokens]) => ({ name, tokens })),
    unassigned,
    stats: {
      count,
      mean,
      variance,
      standardDeviation: Math.sqrt(variance),
      min: values[0] || 0,
      max: values.at(-1) || 0,
      range: count ? values[count - 1] - values[0] : 0,
      median: count
        ? (values[Math.floor((count - 1) / 2)] +
            values[Math.floor(count / 2)]) /
          2
        : 0,
    },
  };
}
