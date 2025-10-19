// src/app/services/maintenance.service.ts
import { Injectable } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import {
  collectionGroup, getDocs, updateDoc,
  doc, getDoc, writeBatch, clearIndexedDbPersistence, terminate
} from 'firebase/firestore';



@Injectable({ providedIn: 'root' })
export class MaintenanceService {
  constructor(private fs: Firestore) {}

  /** 既存 tasks を一括整備（既存のまま） */
  async backfillTasks() {
    const cg = collectionGroup(this.fs as any, 'tasks');
    const snap = await getDocs(cg as any);

    let updated = 0;
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>;
      const patch: Record<string, unknown> = {};

      if (data['projectId'] !== 'default') {
        patch['projectId'] = 'default';
      }

      const due = data['dueDate'];
      if (due === undefined) {
        patch['dueDate'] = null;
      } else if (typeof due === 'string') {
        if (due.includes('T')) {
          const ymd = due.slice(0, 10);
          if (ymd !== due) patch['dueDate'] = ymd;
        }
      }

      if (Object.keys(patch).length > 0) {
        try {
          await updateDoc(d.ref, patch);
          updated++;
        } catch (err) {
          console.error('backfill failed for', d.ref.path, patch, err);
        }
      }
    }
    console.log('tasks backfilled:', updated);
  }

  /** 親 Problem/Issue が存在しない tasks を削除（孤児掃除） */
  async purgeOrphanTasks(dryRun = false) {
    const cg = collectionGroup(this.fs as any, 'tasks');
    const snap = await getDocs(cg as any);

    let checked = 0;
    let deleted = 0;
    const batch = writeBatch(this.fs as any);

    for (const d of snap.docs) {
      checked++;
      const data = d.data() as Record<string, unknown>;

      const projectId = data['projectId'] as string | undefined;
      const problemId = data['problemId'] as string | undefined;
      const issueId   = data['issueId']   as string | undefined;

      // 必須キーが欠けているものも削除対象（必要ならスキップに変えてOK）
      if (!projectId || !problemId || !issueId) {
        if (!dryRun) batch.delete(d.ref);
        deleted++;
        continue;
      }

      const problemRef = doc(this.fs as any, `projects/${projectId}/problems/${problemId}`);
      const issueRef   = doc(this.fs as any, `projects/${projectId}/problems/${problemId}/issues/${issueId}`);

      const [pSnap, iSnap] = await Promise.all([getDoc(problemRef as any), getDoc(issueRef as any)]);

      if (!pSnap.exists() || !iSnap.exists()) {
        if (!dryRun) batch.delete(d.ref);
        deleted++;
      }
    }

    if (!dryRun && deleted > 0) {
      await batch.commit();
    }
    console.log(`[purgeOrphanTasks] checked=${checked} ${dryRun ? 'wouldDelete' : 'deleted'}=${deleted}`);
  }

  async clearLocalCacheOnce(db: Firestore) {
    try {
      await terminate(db as any);
      await clearIndexedDbPersistence(db as any);
      console.log('[maintenance] firestore local cache cleared');
    } catch (e) {
      console.warn('[maintenance] clear cache failed', e);
    }
  }
}



