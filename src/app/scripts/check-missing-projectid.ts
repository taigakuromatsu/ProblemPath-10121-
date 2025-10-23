// 既存のタスクでprojectIdフィールドが欠けているものを確認するスクリプト
import { Firestore } from '@angular/fire/firestore';
import { collectionGroup, getDocs, query, where, updateDoc } from 'firebase/firestore';

export async function checkMissingProjectId(fs: Firestore) {
  console.log('既存のタスクでprojectIdフィールドが欠けているものを確認中...');
  
  // projectIdフィールドが存在しないタスクを検索
  const q = query(
    collectionGroup(fs, 'tasks'),
    where('projectId', '==', null)
  );
  
  const snapshot = await getDocs(q);
  console.log(`projectIdがnullのタスク数: ${snapshot.size}`);
  
  if (snapshot.size > 0) {
    console.log('projectIdがnullのタスク:');
    snapshot.forEach(doc => {
      console.log(`- ${doc.id}: ${doc.data()['title']}`);
    });
  }
  
  // projectIdフィールドが存在しないタスクを検索（undefinedの場合）
  const q2 = query(
    collectionGroup(fs, 'tasks')
  );
  
  const snapshot2 = await getDocs(q2);
  let missingCount = 0;
  
  snapshot2.forEach(doc => {
    const data = doc.data();
    if (!data.hasOwnProperty('projectId')) {
      missingCount++;
      console.log(`- ${doc.id}: ${data['title']} (projectIdフィールドが存在しない)`);
    }
  });
  
  console.log(`projectIdフィールドが存在しないタスク数: ${missingCount}`);
  console.log(`総タスク数: ${snapshot2.size}`);
  
  return {
    nullCount: snapshot.size,
    missingCount,
    totalCount: snapshot2.size
  };
}

// 既存のタスクにprojectIdフィールドを追加するスクリプト
export async function fixMissingProjectId(fs: Firestore, projectId: string = 'default') {
  console.log(`既存のタスクにprojectId: ${projectId} を追加中...`);
  
  const q = query(collectionGroup(fs, 'tasks'));
  const snapshot = await getDocs(q);
  
  let fixedCount = 0;
  
  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (!data.hasOwnProperty('projectId')) {
      await updateDoc(doc.ref, { projectId });
      fixedCount++;
      console.log(`- ${doc.id}: ${data['title']} を修正`);
    }
  }
  
  console.log(`${fixedCount}個のタスクを修正しました`);
  return fixedCount;
}
