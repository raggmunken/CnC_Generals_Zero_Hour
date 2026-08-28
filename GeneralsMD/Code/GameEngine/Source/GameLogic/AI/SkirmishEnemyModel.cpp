/*
**	Command & Conquer Generals Zero Hour(tm)
**	Copyright 2025 Electronic Arts Inc.
**
**	This program is free software: you can redistribute it and/or modify
**	it under the terms of the GNU General Public License as published by
**	the Free Software Foundation, either version 3 of the License, or
**	(at your option) any later version.
**
**	This program is distributed in the hope that it will be useful,
**	but WITHOUT ANY WARRANTY; without even the implied warranty of
**	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
**	GNU General Public License for more details.
**
**	You should have received a copy of the GNU General Public License
**	along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// SkirmishEnemyModel.cpp
// Implementation of the fog-respecting enemy observation model.

#include "PreRTS.h"	// This must go first in EVERY cpp file int the GameEngine

#include "GameLogic/SkirmishEnemyModel.h"

#include "Common/GameCommon.h"
#include "Common/Player.h"
#include "Common/PlayerList.h"
#include "Common/Team.h"
#include "Common/ThingTemplate.h"
#include "GameLogic/GameLogic.h"
#include "GameLogic/Object.h"
#include "GameLogic/PartitionManager.h"

//-----------------------------------------------------------------------------
// Tuning. These are the knobs that decide how "sharp" the AI's memory is.
//-----------------------------------------------------------------------------

/// How long it takes a remembered force to fade to half strength.
static const Real MEMORY_HALF_LIFE_SECONDS = 45.0f;

/// Enemy air presence above this fraction of their mobile force warrants AA.
static const Real ANTI_AIR_TRIGGER_FRACTION = 0.15f;

/// ...or this many absolute aircraft, whichever comes first.
static const Real ANTI_AIR_TRIGGER_COUNT = 2.0f;

/// Below this total remembered strength we consider ourselves blind.
static const Real BLIND_THRESHOLD = 0.5f;

//=============================================================================
void EnemyEstimate::clear( void )
{
	for( Int i = 0; i < THREAT_CATEGORY_COUNT; ++i )
	{
		m_strength[i] = 0.0f;
		m_lastSeenFrame[i] = 0;
	}
	m_estimatedBaseCenter.zero();
	m_baseCenterKnown = FALSE;
	m_lastContactFrame = 0;
}

//=============================================================================
SkirmishEnemyModel::SkirmishEnemyModel()
{
	reset();
}

//=============================================================================
void SkirmishEnemyModel::reset( void )
{
	for( Int i = 0; i < MAX_PLAYER_COUNT; ++i )
		m_estimate[i].clear();

	m_lastUpdateFrame = 0;
	m_everSawAnything = FALSE;
}

//=============================================================================
/**
 * Decide which broad bucket an object falls into.
 *
 * Order matters: aircraft are also vehicles by KindOf, so test flight first.
 */
ThreatCategory SkirmishEnemyModel::categorize( const Object *obj )
{
	if( obj == NULL )
		return THREAT_CATEGORY_COUNT;

	if( obj->isKindOf( KINDOF_AIRCRAFT ) )
		return THREAT_AIRCRAFT;

	if( obj->isKindOf( KINDOF_STRUCTURE ) )
		return THREAT_STRUCTURE;

	// Dozers and workers are economy, not threat. Counting them as vehicles
	// would make a peaceful expanding opponent look like an armored push.
	if( obj->isKindOf( KINDOF_DOZER ) )
		return THREAT_CATEGORY_COUNT;

	if( obj->isKindOf( KINDOF_VEHICLE ) )
		return THREAT_VEHICLE;

	if( obj->isKindOf( KINDOF_INFANTRY ) )
		return THREAT_INFANTRY;

	return THREAT_CATEGORY_COUNT;
}

//=============================================================================
/**
 * Age every remembered figure toward zero.
 *
 * Exponential decay keyed to elapsed frames, so the model behaves the same
 * whether the strategic tick runs every second or every five.
 */
void SkirmishEnemyModel::applyDecay( void )
{
	UnsignedInt now = TheGameLogic->getFrame();
	if( now <= m_lastUpdateFrame )
		return;

	Real elapsedFrames = (Real)(now - m_lastUpdateFrame);
	Real halfLifeFrames = MEMORY_HALF_LIFE_SECONDS * (Real)LOGICFRAMES_PER_SECOND;
	if( halfLifeFrames < 1.0f )
		halfLifeFrames = 1.0f;

	Real factor = (Real)pow( 0.5, (double)(elapsedFrames / halfLifeFrames) );

	for( Int p = 0; p < MAX_PLAYER_COUNT; ++p )
	{
		for( Int c = 0; c < THREAT_CATEGORY_COUNT; ++c )
		{
			m_estimate[p].m_strength[c] *= factor;

			// Snap tiny residue to zero so "blind" is reachable.
			if( m_estimate[p].m_strength[c] < 0.01f )
				m_estimate[p].m_strength[c] = 0.0f;
		}
	}
}

//=============================================================================
/**
 * Sweep every object we can legally see and fold it into the estimate.
 *
 * We take max(remembered, observed) per category rather than summing. Summing
 * would double-count: seeing the same ten tanks on two consecutive ticks does
 * not mean the enemy has twenty. Max means a fresh sighting supersedes stale
 * memory, while memory survives when we lose vision.
 */
void SkirmishEnemyModel::observe( Player *self )
{
	if( self == NULL )
		return;

	// Fresh tally for this observation pass.
	Real observed[MAX_PLAYER_COUNT][THREAT_CATEGORY_COUNT];
	Coord3D structureSum[MAX_PLAYER_COUNT];
	Int structureCount[MAX_PLAYER_COUNT];

	Int p, c;
	for( p = 0; p < MAX_PLAYER_COUNT; ++p )
	{
		for( c = 0; c < THREAT_CATEGORY_COUNT; ++c )
			observed[p][c] = 0.0f;

		structureSum[p].zero();
		structureCount[p] = 0;
	}

	// Only what is alive and genuinely visible to us. No fog peeking.
	PartitionFilterAlive		aliveFilter;
	PartitionFilterFreeOfFog	fogFilter( self->getPlayerIndex() );
	PartitionFilter *filters[] = { &aliveFilter, &fogFilter, NULL };

	SimpleObjectIterator *iter = ThePartitionManager->iterateAllObjects( filters );
	MemoryPoolObjectHolder holder( iter );

	UnsignedInt now = TheGameLogic->getFrame();

	for( Object *obj = iter->first(); obj; obj = iter->next() )
	{
		if( obj->isEffectivelyDead() )
			continue;

		Player *owner = obj->getControllingPlayer();
		if( owner == NULL || owner == self )
			continue;

		if( self->getRelationship( obj->getTeam() ) != ENEMIES )
			continue;

		Int idx = owner->getPlayerIndex();
		if( idx < 0 || idx >= MAX_PLAYER_COUNT )
			continue;

		ThreatCategory cat = categorize( obj );
		if( cat == THREAT_CATEGORY_COUNT )
			continue;

		observed[idx][cat] += 1.0f;
		m_estimate[idx].m_lastContactFrame = now;
		m_estimate[idx].m_lastSeenFrame[cat] = now;
		m_everSawAnything = TRUE;

		if( cat == THREAT_STRUCTURE )
		{
			const Coord3D *pos = obj->getPosition();
			structureSum[idx].x += pos->x;
			structureSum[idx].y += pos->y;
			structureSum[idx].z += pos->z;
			structureCount[idx]++;
		}
	}

	// Fold observations into memory.
	for( p = 0; p < MAX_PLAYER_COUNT; ++p )
	{
		for( c = 0; c < THREAT_CATEGORY_COUNT; ++c )
		{
			if( observed[p][c] > m_estimate[p].m_strength[c] )
				m_estimate[p].m_strength[c] = observed[p][c];
		}

		// Enemy structures do not walk away, so their centroid is a durable
		// anchor for "where does this player live".
		if( structureCount[p] > 0 )
		{
			Real inv = 1.0f / (Real)structureCount[p];
			m_estimate[p].m_estimatedBaseCenter.x = structureSum[p].x * inv;
			m_estimate[p].m_estimatedBaseCenter.y = structureSum[p].y * inv;
			m_estimate[p].m_estimatedBaseCenter.z = structureSum[p].z * inv;
			m_estimate[p].m_baseCenterKnown = TRUE;
		}
	}
}

//=============================================================================
void SkirmishEnemyModel::update( Player *self )
{
	applyDecay();
	observe( self );
	m_lastUpdateFrame = TheGameLogic->getFrame();
}

//=============================================================================
Real SkirmishEnemyModel::getThreat( ThreatCategory cat ) const
{
	if( cat < 0 || cat >= THREAT_CATEGORY_COUNT )
		return 0.0f;

	Real total = 0.0f;
	for( Int p = 0; p < MAX_PLAYER_COUNT; ++p )
		total += m_estimate[p].m_strength[cat];

	return total;
}

//=============================================================================
Real SkirmishEnemyModel::getTotalThreat( void ) const
{
	Real total = 0.0f;
	for( Int c = 0; c < THREAT_CATEGORY_COUNT; ++c )
		total += getThreat( (ThreatCategory)c );

	return total;
}

//=============================================================================
/// Mobile force only -- structures are not part of the composition question.
static Real getMobileTotal( const SkirmishEnemyModel *model )
{
	return model->getThreat( THREAT_INFANTRY )
			 + model->getThreat( THREAT_VEHICLE )
			 + model->getThreat( THREAT_AIRCRAFT );
}

//=============================================================================
Real SkirmishEnemyModel::getAirFraction( void ) const
{
	Real mobile = getMobileTotal( this );
	if( mobile <= 0.0f )
		return 0.0f;

	return getThreat( THREAT_AIRCRAFT ) / mobile;
}

//=============================================================================
Real SkirmishEnemyModel::getInfantryFraction( void ) const
{
	Real mobile = getMobileTotal( this );
	if( mobile <= 0.0f )
		return 0.0f;

	return getThreat( THREAT_INFANTRY ) / mobile;
}

//=============================================================================
Bool SkirmishEnemyModel::needsAntiAir( void ) const
{
	Real air = getThreat( THREAT_AIRCRAFT );

	if( air >= ANTI_AIR_TRIGGER_COUNT )
		return TRUE;

	return getAirFraction() >= ANTI_AIR_TRIGGER_FRACTION && air > 0.0f;
}

//=============================================================================
Bool SkirmishEnemyModel::isBlind( void ) const
{
	return getTotalThreat() < BLIND_THRESHOLD;
}

//=============================================================================
Int SkirmishEnemyModel::getPrimaryEnemyIndex( void ) const
{
	Int best = -1;
	Real bestScore = 0.0f;

	for( Int p = 0; p < MAX_PLAYER_COUNT; ++p )
	{
		Real score = 0.0f;
		for( Int c = 0; c < THREAT_CATEGORY_COUNT; ++c )
			score += m_estimate[p].m_strength[c];

		if( score > bestScore )
		{
			bestScore = score;
			best = p;
		}
	}

	return best;
}

//=============================================================================
Bool SkirmishEnemyModel::getPrimaryEnemyBaseCenter( Coord3D *outPos ) const
{
	if( outPos == NULL )
		return FALSE;

	Int idx = getPrimaryEnemyIndex();

	// Fall back to any player whose base we do know, if the strongest is a
	// roaming army we have never traced back to a base.
	if( idx < 0 || !m_estimate[idx].m_baseCenterKnown )
	{
		idx = -1;
		for( Int p = 0; p < MAX_PLAYER_COUNT; ++p )
		{
			if( m_estimate[p].m_baseCenterKnown )
			{
				idx = p;
				break;
			}
		}
	}

	if( idx < 0 || !m_estimate[idx].m_baseCenterKnown )
		return FALSE;

	*outPos = m_estimate[idx].m_estimatedBaseCenter;
	return TRUE;
}

//=============================================================================
UnsignedInt SkirmishEnemyModel::getFramesSinceContact( void ) const
{
	if( !m_everSawAnything )
		return 0xFFFFFFFF;

	UnsignedInt now = TheGameLogic->getFrame();
	UnsignedInt latest = 0;

	for( Int p = 0; p < MAX_PLAYER_COUNT; ++p )
	{
		if( m_estimate[p].m_lastContactFrame > latest )
			latest = m_estimate[p].m_lastContactFrame;
	}

	return (now > latest) ? (now - latest) : 0;
}
