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

// SkirmishEnemyModel.h
// A fog-respecting memory of what the enemy has been seen fielding.
//
// The stock AIPlayer keeps no record of the opponent whatsoever -- its build
// decisions consult only its own affordability and script-authored priorities.
// This class supplies the missing half: an observation of enemy forces that
// decays with age, so the AI can counter what it has actually seen rather than
// what a level designer guessed at.
//
// Deliberately does NOT peek through fog of war. Everything here is gathered
// with PartitionFilterFreeOfFog, so the resulting opponent is strong because it
// reacts, not because it cheats.

#pragma once

#ifndef _SKIRMISH_ENEMY_MODEL_H_
#define _SKIRMISH_ENEMY_MODEL_H_

#include "Common/GameCommon.h"
#include "Common/GameType.h"
#include "Lib/BaseType.h"

class Player;

/// Broad force categories we track and counter against.
enum ThreatCategory
{
	THREAT_INFANTRY = 0,			///< foot units
	THREAT_VEHICLE,						///< ground vehicles
	THREAT_AIRCRAFT,					///< planes and helicopters
	THREAT_STRUCTURE,					///< buildings, including base defense

	THREAT_CATEGORY_COUNT
};

/// What we believe about a single opposing player.
struct EnemyEstimate
{
	Real				m_strength[THREAT_CATEGORY_COUNT];		///< decayed count of units seen
	UnsignedInt	m_lastSeenFrame[THREAT_CATEGORY_COUNT];	///< when each category was last observed
	Coord3D			m_estimatedBaseCenter;								///< centroid of enemy structures we have seen
	Bool				m_baseCenterKnown;										///< is m_estimatedBaseCenter meaningful
	UnsignedInt	m_lastContactFrame;										///< last frame we saw anything at all

	void clear( void );
};

/**
 * Maintains a decaying, fog-limited picture of every enemy player.
 *
 * Call update() from the AI's strategic tick (not per-frame -- this walks the
 * partition manager and is far too heavy for 30Hz).
 */
class SkirmishEnemyModel
{
public:

	SkirmishEnemyModel();

	/// Forget everything. Call on new map.
	void reset( void );

	/// Observe the world and age existing knowledge. 'self' is the AI's player.
	void update( Player *self );

	//-------------------------------------------------------------------------
	// Queries used to shape production decisions.
	//-------------------------------------------------------------------------

	/// Summed decayed strength of a category across all enemies.
	Real getThreat( ThreatCategory cat ) const;

	/// Total enemy strength we are aware of, all categories, all players.
	Real getTotalThreat( void ) const;

	/// Fraction of observed enemy mobile force that flies. 0.0 if nothing seen.
	Real getAirFraction( void ) const;

	/// Fraction of observed enemy mobile force that is on foot. 0.0 if nothing seen.
	Real getInfantryFraction( void ) const;

	/// True once the enemy has shown enough air power to justify dedicated AA.
	Bool needsAntiAir( void ) const;

	/// True when we have seen essentially nothing -- we are blind and should scout.
	Bool isBlind( void ) const;

	/// Best guess at where the strongest enemy lives. False if never seen one.
	Bool getPrimaryEnemyBaseCenter( Coord3D *outPos ) const;

	/// Which player index we consider the biggest problem. -1 if none seen.
	Int getPrimaryEnemyIndex( void ) const;

	/// Frames since we last laid eyes on any enemy at all.
	UnsignedInt getFramesSinceContact( void ) const;

protected:

	/// Sweep the map for visible enemy objects and fold them into the estimate.
	void observe( Player *self );

	/// Age all knowledge toward zero.
	void applyDecay( void );

	/// Categorize a single object. Returns THREAT_CATEGORY_COUNT if uninteresting.
	static ThreatCategory categorize( const Object *obj );

private:

	EnemyEstimate	m_estimate[MAX_PLAYER_COUNT];
	UnsignedInt		m_lastUpdateFrame;
	Bool					m_everSawAnything;
};

#endif // _SKIRMISH_ENEMY_MODEL_H_
