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

// AISmartSkirmishPlayer.cpp

#include "PreRTS.h"	// This must go first in EVERY cpp file int the GameEngine

#include "GameLogic/AISmartSkirmishPlayer.h"

#include "Common/GameCommon.h"
#include "Common/GlobalData.h"
#include "Common/Player.h"
#include "Common/PlayerList.h"
#include "Common/Team.h"
#include "Common/ThingFactory.h"
#include "Common/ThingTemplate.h"
#include "GameLogic/GameLogic.h"
#include "GameLogic/Object.h"
#include "GameLogic/AI.h"
#include "GameLogic/ScriptEngine.h"
#include "GameLogic/Weapon.h"
#include "GameLogic/WeaponSet.h"

//-----------------------------------------------------------------------------
// Tuning knobs. These are the first things to sweep when evaluating the bot.
//-----------------------------------------------------------------------------

/// How often the enemy model re-sweeps the map. The sweep walks every object,
/// so this must stay well above the logic frame rate.
static const Int MODEL_UPDATE_INTERVAL_SECONDS = 2;

/// Weight given to the map-authored production priority.
static const Real PRIORITY_WEIGHT = 1.0f;

/// Reward for fielding anti-air while the enemy is actually flying.
static const Real AA_URGENCY_BONUS = 40.0f;

/// Penalty for building yet more AA when nothing has ever flown at us.
static const Real AA_WASTE_PENALTY = 15.0f;

/// Reward for massing infantry against an infantry-heavy opponent.
static const Real INFANTRY_MIRROR_BONUS = 10.0f;

/// Reward for anything at all while we are blind and need presence on the map.
static const Real BLIND_SCOUT_BONUS = 8.0f;

//=============================================================================
AISmartSkirmishPlayer::AISmartSkirmishPlayer( Player *p ) :
	AISkirmishPlayer( p ),
	m_lastModelUpdateFrame( 0 )
{
	m_enemyModel.reset();
}

//=============================================================================
AISmartSkirmishPlayer::~AISmartSkirmishPlayer()
{
	// Base queue teardown is handled by ~AISkirmishPlayer.
}

//=============================================================================
void AISmartSkirmishPlayer::newMap( void )
{
	m_enemyModel.reset();
	m_lastModelUpdateFrame = 0;

	AISkirmishPlayer::newMap();
}

//=============================================================================
/**
 * Refresh our picture of the opponent, then let the inherited machinery run.
 *
 * The base update() drives base building, team building, upgrades and skills.
 * We only want to be sure the model is current before any of that consults it.
 */
void AISmartSkirmishPlayer::update( void )
{
	UnsignedInt now = TheGameLogic->getFrame();
	UnsignedInt interval = (UnsignedInt)(MODEL_UPDATE_INTERVAL_SECONDS * LOGICFRAMES_PER_SECOND);

	if( now - m_lastModelUpdateFrame >= interval || m_lastModelUpdateFrame == 0 )
	{
		m_enemyModel.update( m_player );
		m_lastModelUpdateFrame = now;
	}

	AISkirmishPlayer::update();
}

//=============================================================================
/**
 * Walk a team's roster looking for a weapon that can hit something airborne.
 *
 * A team prototype names its members by string, so we resolve each through
 * TheThingFactory and inspect every weapon slot of every weapon set.
 */
Bool AISmartSkirmishPlayer::teamCanEngageAir( TeamPrototype *proto )
{
	if( proto == NULL )
		return FALSE;

	const TeamTemplateInfo *info = proto->getTemplateInfo();
	if( info == NULL )
		return FALSE;

	for( Int i = 0; i < info->m_numUnitsInfo; ++i )
	{
		const ThingTemplate *tt = TheThingFactory->findTemplate( info->m_unitsInfo[i].unitThingName, FALSE );
		if( tt == NULL )
			continue;

		const WeaponTemplateSetVector &sets = tt->getWeaponTemplateSets();
		for( WeaponTemplateSetVector::const_iterator it = sets.begin(); it != sets.end(); ++it )
		{
			for( Int slot = 0; slot < WEAPONSLOT_COUNT; ++slot )
			{
				const WeaponTemplate *wt = it->getNth( (WeaponSlotType)slot );
				if( wt == NULL )
					continue;

				if( wt->getAntiMask() & WEAPON_ANTI_AIRBORNE_VEHICLE )
					return TRUE;
			}
		}
	}

	return FALSE;
}

//=============================================================================
Bool AISmartSkirmishPlayer::teamIsMostlyInfantry( TeamPrototype *proto )
{
	if( proto == NULL )
		return FALSE;

	const TeamTemplateInfo *info = proto->getTemplateInfo();
	if( info == NULL )
		return FALSE;

	Int infantry = 0;
	Int total = 0;

	for( Int i = 0; i < info->m_numUnitsInfo; ++i )
	{
		const ThingTemplate *tt = TheThingFactory->findTemplate( info->m_unitsInfo[i].unitThingName, FALSE );
		if( tt == NULL )
			continue;

		Int qty = info->m_unitsInfo[i].maxUnits;
		if( qty <= 0 )
			qty = 1;

		total += qty;
		if( tt->isKindOf( KINDOF_INFANTRY ) )
			infantry += qty;
	}

	return total > 0 && ( (Real)infantry / (Real)total ) > 0.5f;
}

//=============================================================================
/**
 * Rate a candidate team against the current picture of the opponent.
 *
 * The map's production priority is kept as the baseline so scripted campaign
 * maps still behave roughly as their designers intended; the adjustments layer
 * situational judgement on top rather than discarding that intent.
 */
Real AISmartSkirmishPlayer::scoreTeam( TeamPrototype *proto )
{
	if( proto == NULL )
		return -1.0e9f;

	const TeamTemplateInfo *info = proto->getTemplateInfo();
	if( info == NULL )
		return -1.0e9f;

	Real score = PRIORITY_WEIGHT * (Real)info->m_productionPriority;

	const Bool enemyFlies = m_enemyModel.needsAntiAir();
	const Bool canHitAir = teamCanEngageAir( proto );

	// The single biggest failure of the stock AI: it will happily ignore an
	// air force until it loses. Reward the answer, and stop over-investing in
	// AA when nothing has ever flown at us.
	if( enemyFlies && canHitAir )
	{
		score += AA_URGENCY_BONUS * ( 0.5f + m_enemyModel.getAirFraction() );
	}
	else if( !enemyFlies && canHitAir && !m_enemyModel.isBlind() )
	{
		score -= AA_WASTE_PENALTY;
	}

	// Infantry trade well into infantry, and garrison the buildings that an
	// infantry-heavy opponent wants to take.
	if( teamIsMostlyInfantry( proto ) && m_enemyModel.getInfantryFraction() > 0.5f )
	{
		score += INFANTRY_MIRROR_BONUS;
	}

	// If we have seen nothing, almost anything is better than nothing -- being
	// on the map is how we stop being blind.
	if( m_enemyModel.isBlind() )
	{
		score += BLIND_SCOUT_BONUS;
	}

	return score;
}

//=============================================================================
/**
 * Scored replacement for AIPlayer::selectTeamToBuild().
 *
 * Structurally this mirrors the base implementation -- gather candidates via
 * isAGoodIdeaToBuildTeam(), honour selectTeamToReinforce() first -- but the
 * final choice is the highest scoring team rather than a random draw from the
 * top priority band.
 */
Bool AISmartSkirmishPlayer::selectTeamToBuild( void )
{
	// Single pass: collect candidates and the top authored priority together.
	// isAGoodIdeaToBuildTeam() emits debug messages, so calling it twice per
	// team would double every line in the AI debug log.
	Player::PlayerTeamList candidates;
	Int hiPri = -99999;

	Player::PlayerTeamList::const_iterator t;
	for( t = m_player->getPlayerTeams()->begin(); t != m_player->getPlayerTeams()->end(); ++t )
	{
		if( !isAGoodIdeaToBuildTeam( *t ) )
			continue;

		candidates.push_back( *t );

		Int pri = (*t)->getTemplateInfo()->m_productionPriority;
		if( pri > hiPri )
			hiPri = pri;
	}

	// Reinforcing an existing team still beats starting a new one, same as stock.
	if( selectTeamToReinforce( hiPri ) )
		return TRUE;

	if( candidates.empty() )
		return FALSE;

	// Choose by score across ALL buildable teams, not just the top priority
	// band. A well-countered team at priority 3 should beat a useless one at 5.
	TeamPrototype *best = NULL;
	Real bestScore = 0.0f;

	for( t = candidates.begin(); t != candidates.end(); ++t )
	{
		Real score = scoreTeam( *t );
		if( best == NULL || score > bestScore )
		{
			best = *t;
			bestScore = score;
		}
	}

	if( best == NULL )
		return FALSE;

	if( TheGlobalData->m_debugAI )
	{
		AsciiString str;
		str.format( "**SmartAI** Building team %s (score %.1f, airFrac %.2f)",
								best->getName().str(), bestScore, m_enemyModel.getAirFraction() );
		TheScriptEngine->AppendDebugMessage( str, false );
	}

	// Build it at low priority, as we have selected it automagically.
	buildSpecificAITeam( best, FALSE );

	// Same post-selection bookkeeping the base class performs. Omitting this
	// leaves m_readyToBuildTeam latched and the team timer unreset, which makes
	// the AI re-enter selection every tick.
	m_readyToBuildTeam = false;
	m_teamTimer = m_teamSeconds * LOGICFRAMES_PER_SECOND;

	if( m_player->getMoney()->countMoney() < TheAI->getAiData()->m_resourcesPoor )
	{
		m_teamTimer = m_teamTimer / TheAI->getAiData()->m_teamPoorMod;
	}
	else if( m_player->getMoney()->countMoney() > TheAI->getAiData()->m_resourcesWealthy )
	{
		m_teamTimer = m_teamTimer / TheAI->getAiData()->m_teamWealthyMod;
	}

	return TRUE;
}

