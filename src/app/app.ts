import { Component } from '@angular/core';
import { Firestore, collection, addDoc } from '@angular/fire/firestore';
import { CommonModule } from '@angular/common'; // ← ★ これを追加！

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule], // ← ★ これを追加！
  template: `
    <h1>ProblemPath Firestore Test</h1>
    <button (click)="addTestData()">📤 Add Test Data</button>
    <p *ngIf="message">{{ message }}</p>
  `
})
export class App {
  message = '';

  constructor(private firestore: Firestore) {}

  async addTestData() {
    try {
      const testCollection = collection(this.firestore, 'testData');
      await addDoc(testCollection, {
        name: 'ProblemPath Test',
        createdAt: new Date(),
        status: 'ok'
      });
      this.message = '✅ Firestoreにデータを追加しました！';
    } catch (error) {
      console.error('Firestore書き込みエラー:', error);
      this.message = '❌ Firestoreへの追加に失敗しました。';
    }
  }
}

