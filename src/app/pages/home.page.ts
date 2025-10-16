import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';

import { Firestore, collection, addDoc } from '@angular/fire/firestore';
import { serverTimestamp } from 'firebase/firestore';

@Component({
  standalone: true,
  selector: 'pp-home',
  imports: [RouterLink, CommonModule],
  template: `
    <h2>Home</h2>
    <p>動線とFirestore連携の確認ページです。</p>

    <nav>
      <a routerLink="/tree">🌳 Tree</a> |
      <a routerLink="/board">📋 Board</a> |
      <a routerLink="/schedule">📆 Schedule</a>
    </nav>

    <section style="margin-top:16px;">
      <h3>Firestore Test</h3>
      <button (click)="addTestData()">📤 Add Test Data</button>
      <p *ngIf="message">{{ message }}</p>
    </section>
  `
})
export class HomePage {
  message = '';
  constructor(private fs: Firestore) {}

  async addTestData() {
    try {
      const colRef = collection(this.fs, 'testData');
      await addDoc(colRef, {
        name: 'ProblemPath Test',
        status: 'ok',
        createdAt: serverTimestamp(),
      });
      this.message = '✅ Firestoreにデータを追加しました！';
    } catch (error) {
      console.error('Firestore書き込みエラー:', error);
      this.message = '❌ Firestoreへの追加に失敗しました。';
    }
  }
}
