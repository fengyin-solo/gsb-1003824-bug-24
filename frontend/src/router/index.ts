import { createRouter, createWebHistory } from 'vue-router'

import Dashboard from '@/views/Dashboard.vue'
const Trench = () => import('@/views/trench/index.vue')
const Stratum = () => import('@/views/stratum/index.vue')
const Feature = () => import('@/views/feature/index.vue')
const Artifact = () => import('@/views/artifact/index.vue')
const ArtifactDetail = () => import('@/views/artifact/detail.vue')
const Flotation = () => import('@/views/flotation/index.vue')
const Dating = () => import('@/views/dating/index.vue')
const Photography = () => import('@/views/photography/index.vue')
const Drawing = () => import('@/views/drawing/index.vue')
const Diary = () => import('@/views/diary/index.vue')
const Survey = () => import('@/views/survey/index.vue')
const HumanBone = () => import('@/views/human_bone/index.vue')
const AnimalBone = () => import('@/views/animal_bone/index.vue')
const Pottery = () => import('@/views/pottery/index.vue')
const Conservation = () => import('@/views/conservation/index.vue')
const Coordinate = () => import('@/views/coordinate/index.vue')
const Storage = () => import('@/views/storage/index.vue')
const Material = () => import('@/views/material/index.vue')
const Visit = () => import('@/views/visit/index.vue')

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: Dashboard },
    { path: '/trench', name: 'trench', component: Trench },
    { path: '/stratum', name: 'stratum', component: Stratum },
    { path: '/feature', name: 'feature', component: Feature },
    { path: '/artifact', name: 'artifact', component: Artifact },
    { path: '/artifact/:id', name: 'artifact-detail', component: ArtifactDetail },
    { path: '/flotation', name: 'flotation', component: Flotation },
    { path: '/dating', name: 'dating', component: Dating },
    { path: '/photography', name: 'photography', component: Photography },
    { path: '/drawing', name: 'drawing', component: Drawing },
    { path: '/diary', name: 'diary', component: Diary },
    { path: '/survey', name: 'survey', component: Survey },
    { path: '/human_bone', name: 'human_bone', component: HumanBone },
    { path: '/animal_bone', name: 'animal_bone', component: AnimalBone },
    { path: '/pottery', name: 'pottery', component: Pottery },
    { path: '/conservation', name: 'conservation', component: Conservation },
    { path: '/coordinate', name: 'coordinate', component: Coordinate },
    { path: '/storage', name: 'storage', component: Storage },
    { path: '/material', name: 'material', component: Material },
    { path: '/visit', name: 'visit', component: Visit },
  ],
})

export default router
