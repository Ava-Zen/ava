import { Component, EventEmitter, Output, computed, inject, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import {
  MemoryEvent,
  MemoryGraph,
  MemoryGraphNode,
  MemoryNode,
  MemoryService,
} from '../services/memory';
import { markdownToHtml } from '../services/text-format';

export type MemoryView = 'rooms' | 'map' | 'time';

interface PlacedNode extends MemoryGraphNode {
  x: number;
  y: number;
  r: number;
}

@Component({
  selector: 'app-memory',
  standalone: true,
  templateUrl: './memory.html',
  styleUrl: './memory.css',
})
export class MemoryExplorer {
  private readonly memory = inject(MemoryService);
  private readonly sanitizer = inject(DomSanitizer);

  @Output() readonly close = new EventEmitter<void>();

  protected readonly path = signal('');
  protected readonly current = signal<MemoryNode | null>(null);
  protected readonly children = signal<MemoryNode[]>([]);
  protected readonly loading = signal(true);
  protected readonly view = signal<MemoryView>('rooms');
  protected readonly graph = signal<MemoryGraph>({ nodes: [], edges: [] });
  protected readonly events = signal<MemoryEvent[]>([]);
  protected readonly homeLabel = this.memory.homeLabel;
  protected readonly homePath = this.memory.homePath;
  protected readonly desktop = this.memory.desktop;
  protected readonly activeTopic = this.memory.activeTopic;
  protected readonly lastNotice = this.memory.lastNotice;
  protected readonly homeError = this.memory.homeError;
  protected readonly crumbs = computed(() => crumbTrail(this.path()));
  protected readonly bodyHtml = computed<SafeHtml | null>(() => {
    const node = this.current();
    if (!node?.body?.trim()) return null;
    return this.sanitizer.bypassSecurityTrustHtml(markdownToHtml(node.body));
  });
  protected readonly placed = computed(() => layoutGraph(this.graph()));
  protected readonly mapWidth = 640;
  protected readonly mapHeight = 420;

  constructor() {
    const start = this.memory.focusRel();
    this.memory.focusRel.set('');
    void this.open(start);
  }

  protected async open(rel: string): Promise<void> {
    this.loading.set(true);
    this.path.set(rel);
    try {
      const [current, children, events] = await Promise.all([
        this.memory.nodeAt(rel),
        this.memory.childrenOf(rel),
        this.memory.timeline(),
      ]);
      this.current.set(current);
      this.children.set(children);
      this.events.set(filterEvents(events, rel));
      this.graph.set(this.memory.constellation(rel));
    } finally {
      this.loading.set(false);
    }
  }

  protected setView(view: MemoryView): void {
    this.view.set(view);
  }

  protected async openChild(node: MemoryNode): Promise<void> {
    await this.open(node.rel);
  }

  protected async openRel(rel: string): Promise<void> {
    await this.open(rel);
  }

  protected async pickFolder(): Promise<void> {
    await this.memory.pickHomeFolder();
    await this.open('');
  }

  protected isActive(node: { rel: string; id?: string }): boolean {
    const active = this.activeTopic();
    if (!active) return false;
    return node.rel === `topics/${active.id}` || node.rel.startsWith(`topics/${active.id}/`) || node.id === active.id;
  }

  protected edgePath(fromId: string, toId: string): string {
    const nodes = this.placed();
    const from = nodes.find(node => node.id === fromId);
    const to = nodes.find(node => node.id === toId);
    if (!from || !to) return '';
    return `M ${from.x} ${from.y} Q ${(from.x + to.x) / 2} ${(from.y + to.y) / 2 - 28} ${to.x} ${to.y}`;
  }

  protected dayLabel(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
}

function crumbTrail(rel: string): Array<{ label: string; rel: string }> {
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  const crumbs = [{ label: 'Home', rel: '' }];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push({
      label: part.replace(/\.md$/i, '').replace(/[-_]+/g, ' '),
      rel: acc,
    });
  }
  return crumbs;
}

function filterEvents(events: MemoryEvent[], rel: string): MemoryEvent[] {
  const path = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!path) return events;
  return events.filter(event => event.rel === path || event.rel?.startsWith(`${path}/`) || event.rel === path);
}

function layoutGraph(graph: MemoryGraph): PlacedNode[] {
  const width = 640;
  const height = 420;
  const cx = width / 2;
  const cy = height / 2;
  const nodes = graph.nodes;
  if (!nodes.length) return [];
  if (nodes.length === 1) {
    return [{ ...nodes[0], x: cx, y: cy, r: 28 }];
  }
  const hub = nodes.find(node => node.id === 'ava') ?? nodes[0];
  const rest = nodes.filter(node => node.id !== hub.id);
  const radius = Math.min(width, height) * 0.34;
  const placed: PlacedNode[] = [
    { ...hub, x: cx, y: cy, r: 32 },
  ];
  rest.forEach((node, index) => {
    const angle = -Math.PI / 2 + (index / rest.length) * Math.PI * 2;
    const orbit = radius + (node.weight - 1) * 8;
    placed.push({
      ...node,
      x: cx + Math.cos(angle) * orbit,
      y: cy + Math.sin(angle) * orbit,
      r: 16 + node.weight * 3,
    });
  });
  return placed;
}
