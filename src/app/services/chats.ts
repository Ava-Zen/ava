import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { GardensService } from './gardens';

export interface ChatThread {
  id: string;
  gardenId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspace?: string;
  allowLocalTools?: boolean;
}

const STORAGE_KEY = 'ava-chats';
const CURRENT_KEY = 'ava-current-chat';

@Injectable({ providedIn: 'root' })
export class ChatsService {
  private readonly gardens = inject(GardensService);
  readonly chats = signal<ChatThread[]>([]);
  readonly currentChatId = signal('');

  readonly currentChat = computed(() => {
    const id = this.currentChatId();
    return this.chats().find(chat => chat.id === id) ?? null;
  });

  readonly chatsInGarden = computed(() => {
    const gardenId = this.gardens.currentGarden()?.id;
    return this.chats()
      .filter(chat => chat.gardenId === gardenId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });

  constructor() {
    this.load();
    effect(() => this.persist());
    effect(() => {
      const gardenId = this.gardens.currentGarden()?.id;
      if (!gardenId) return;
      const current = this.currentChat();
      if (!current || current.gardenId !== gardenId) {
        this.ensureChatForGarden(gardenId);
      }
    });
  }

  createChat(gardenId?: string, title = 'New chat'): ChatThread {
    const garden = gardenId || this.gardens.currentGarden()?.id;
    if (!garden) throw new Error('No garden for chat.');
    const chat: ChatThread = {
      id: this.nextId(),
      gardenId: garden,
      title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspace: undefined,
      allowLocalTools: false,
    };
    this.chats.update(list => [chat, ...list]);
    this.currentChatId.set(chat.id);
    return chat;
  }

  selectChat(id: string): void {
    if (this.chats().some(chat => chat.id === id)) {
      this.currentChatId.set(id);
      const chat = this.chats().find(item => item.id === id);
      if (chat) this.gardens.selectGarden(chat.gardenId);
    }
  }

  touch(id = this.currentChatId(), title?: string): void {
    if (!id) return;
    this.chats.update(list =>
      list.map(chat =>
        chat.id === id
          ? {
              ...chat,
              title: title?.trim() || chat.title,
              updatedAt: new Date().toISOString(),
            }
          : chat
      )
    );
  }

  setWorkspace(path: string, id = this.currentChatId()): void {
    const workspace = path.trim();
    this.patch(id, { workspace: workspace || undefined });
    if (workspace) this.gardens.rememberWorkspace(workspace);
  }

  setAllowLocalTools(allow: boolean, id = this.currentChatId()): void {
    this.patch(id, { allowLocalTools: allow });
  }

  deleteChat(id: string): void {
    const remaining = this.chats().filter(chat => chat.id !== id);
    if (!remaining.length) {
      const gardenId = this.chats().find(chat => chat.id === id)?.gardenId
        || this.gardens.currentGarden()?.id;
      if (!gardenId) return;
      this.chats.set([]);
      this.createChat(gardenId);
      return;
    }
    this.chats.set(remaining);
    if (this.currentChatId() === id) {
      this.currentChatId.set(remaining[0].id);
    }
  }

  deleteForGarden(gardenId: string): void {
    this.chats.update(list => list.filter(chat => chat.gardenId !== gardenId));
  }

  collapseToSingle(): ChatThread | null {
    const gardenId = this.gardens.currentGarden()?.id;
    const existing = this.chats();
    if (!existing.length) {
      return gardenId ? this.createChat(gardenId) : null;
    }
    const primary = [...existing].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (existing.length > 1) {
      this.chats.set([primary]);
    }
    this.currentChatId.set(primary.id);
    if (primary.gardenId) this.gardens.selectGarden(primary.gardenId);
    return primary;
  }

  ensureChatForGarden(gardenId: string): ChatThread {
    const existing = this.chats()
      .filter(chat => chat.gardenId === gardenId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (existing) {
      this.currentChatId.set(existing.id);
      return existing;
    }
    return this.createChat(gardenId);
  }

  workspaceLabel(path: string | undefined): string {
    return this.gardens.workspaceLabel(path);
  }

  private patch(id: string, updates: Partial<ChatThread>): void {
    if (!id) return;
    this.chats.update(list =>
      list.map(chat => (chat.id === id ? { ...chat, ...updates, updatedAt: new Date().toISOString() } : chat))
    );
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as ChatThread[];
        if (Array.isArray(parsed)) this.chats.set(parsed.filter(chat => chat?.id && chat.gardenId));
      }
      const current = localStorage.getItem(CURRENT_KEY);
      if (current && this.chats().some(chat => chat.id === current)) {
        this.currentChatId.set(current);
      }
    } catch {
      this.chats.set([]);
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.chats()));
      localStorage.setItem(CURRENT_KEY, this.currentChatId());
    } catch {
      // ignore
    }
  }

  private nextId(): string {
    return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }
}
